"use strict";

const { execute, validateSchema, parse, validate, specifiedRules, GraphQLError } = require("graphql");
const schema = require("./schema");
const { createLoaders } = require("./loaders");
const { createServiceLogger } = require("../utils/logger");

const logger = createServiceLogger("graphql");

const isDev = process.env.NODE_ENV !== "production";
const MAX_QUERY_DEPTH = 8;
const MAX_QUERY_COMPLEXITY = 100;

function introspectionRule(context) {
  return {
    Field(node) {
      if (node.name.value === "__schema" || node.name.value === "__type") {
        context.reportError(
          new GraphQLError("Introspection is disabled in production", { nodes: node }),
        );
      }
    },
  };
}

function queryLimitsExceeded(document) {
  const fragments = new Map(
    document.definitions
      .filter((definition) => definition.kind === "FragmentDefinition")
      .map((fragment) => [fragment.name.value, fragment]),
  );
  const operations = document.definitions.filter(
    (definition) => definition.kind === "OperationDefinition",
  );

  return operations.some((operation) => {
    let complexity = 0;
    let depth = 0;

    function measure(selectionSet, parentDepth, activeFragments = new Set()) {
      for (const selection of selectionSet.selections) {
        if (selection.kind === "Field") {
          complexity += 1;
          const fieldDepth = parentDepth + 1;
          depth = Math.max(depth, fieldDepth);
          if (selection.selectionSet) {
            measure(selection.selectionSet, fieldDepth, activeFragments);
          }
        } else if (selection.kind === "InlineFragment") {
          measure(selection.selectionSet, parentDepth, activeFragments);
        } else if (selection.kind === "FragmentSpread") {
          const fragment = fragments.get(selection.name.value);
          if (fragment && !activeFragments.has(fragment.name.value)) {
            const nextActiveFragments = new Set(activeFragments);
            nextActiveFragments.add(fragment.name.value);
            measure(fragment.selectionSet, parentDepth, nextActiveFragments);
          }
        }
      }
    }

    measure(operation.selectionSet, 0);
    return depth > MAX_QUERY_DEPTH || complexity > MAX_QUERY_COMPLEXITY;
  });
}

function handleGraphQL(req, res) {
  if (req.method === "GET" && isDev) {
    res.status(200).send("GraphQL endpoint ready. Send POST requests with JSON body { query, variables }.");
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed. Use POST." });
    return;
  }

  const { query, variables, operationName } = req.body || {};

  if (!query || typeof query !== "string") {
    res.status(400).json({ error: "Must provide a query string." });
    return;
  }

  // Schema must be valid before we attempt to parse or validate a query against it.
  const schemaErrors = validateSchema(schema);
  if (schemaErrors.length > 0) {
    logger.error({ errors: schemaErrors.map((e) => e.message) }, "GraphQL schema is invalid");
    res.status(500).json({ errors: [{ message: "GraphQL schema is invalid" }] });
    return;
  }

  let document;
  try {
    document = parse(query);
  } catch (syntaxError) {
    res.status(400).json({ errors: [{ message: syntaxError.message }] });
    return;
  }

  const validationRules = [...specifiedRules];
  if (!isDev) {
    validationRules.push(introspectionRule);
  }

  const validationErrors = validate(schema, document, validationRules);
  if (validationErrors.length > 0) {
    logger.error({ errors: validationErrors.map((e) => e.message) }, "GraphQL validation error");
    res.status(400).json({ errors: validationErrors.map((e) => ({ message: e.message })) });
    return;
  }

  if (queryLimitsExceeded(document)) {
    res.status(400).json({
      errors: [{
        message: `Query exceeds the maximum depth (${MAX_QUERY_DEPTH}) or complexity (${MAX_QUERY_COMPLEXITY})`,
      }],
    });
    return;
  }

  const loaders = createLoaders();
  const context = { loaders, req, user: req.user };

  Promise.resolve()
    .then(() =>
      execute({
        schema,
        document,
        variableValues: variables,
        operationName,
        contextValue: context,
      }),
    )
    .then((result) => {
      if (result.errors) {
        logger.error({ errors: result.errors.map((e) => e.message) }, "GraphQL error");
      }
      res.json(result);
    })
    .catch((err) => {
      if (err instanceof GraphQLError) {
        res.status(400).json({ errors: [{ message: err.message }] });
        return;
      }
      logger.error({ err }, "GraphQL fatal error");
      res.status(500).json({ errors: [{ message: "Internal server error" }] });
    });
}

module.exports = handleGraphQL;
