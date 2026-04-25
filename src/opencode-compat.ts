type SchemaNode = {
  kind: string;
  values?: unknown;
  inner?: unknown;
  metadata?: Record<string, unknown>;
  optional(): SchemaNode;
  describe(description: string): SchemaNode;
  min(value: number): SchemaNode;
  max(value: number): SchemaNode;
  int(): SchemaNode;
};

function createSchemaNode(kind: string, values?: unknown, inner?: unknown): SchemaNode {
  const node: SchemaNode = {
    kind,
    values,
    inner,
    metadata: {},
    optional() {
      this.metadata = { ...(this.metadata ?? {}), optional: true };
      return this;
    },
    describe(description: string) {
      this.metadata = { ...(this.metadata ?? {}), description };
      return this;
    },
    min(value: number) {
      this.metadata = { ...(this.metadata ?? {}), min: value };
      return this;
    },
    max(value: number) {
      this.metadata = { ...(this.metadata ?? {}), max: value };
      return this;
    },
    int() {
      this.metadata = { ...(this.metadata ?? {}), int: true };
      return this;
    },
  };
  return node;
}

export const tool = Object.assign(
  <T extends Record<string, unknown>>(definition: T): T => definition,
  {
    schema: {
      string: () => createSchemaNode("string"),
      number: () => createSchemaNode("number"),
      boolean: () => createSchemaNode("boolean"),
      any: () => createSchemaNode("any"),
      enum: (values: readonly unknown[]) => createSchemaNode("enum", [...values]),
      union: (values: readonly unknown[]) => createSchemaNode("union", [...values]),
      array: (inner: unknown) => createSchemaNode("array", undefined, inner),
    },
  },
);
