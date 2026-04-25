type RegisteredTool = {
  name: string;
  execute: (...args: any[]) => Promise<any> | any;
};

export async function loadRegisteredTools(modulePath = "../index.ts"): Promise<Map<string, RegisteredTool>> {
  const registry = new Map<string, RegisteredTool>();
  const extensionModule = await import(modulePath);
  const extension = extensionModule.default as ((pi: any) => void) | undefined;
  if (typeof extension !== "function") {
    throw new Error(`Extension module '${modulePath}' has no default function export.`);
  }

  extension({
    registerTool(tool: RegisteredTool) {
      registry.set(tool.name, tool);
    },
  });

  return registry;
}

export async function invokeRegisteredTool(name: string, args: Record<string, unknown>, modulePath = "../index.ts"): Promise<string> {
  const tools = await loadRegisteredTools(modulePath);
  const tool = tools.get(name);
  if (!tool) {
    throw new Error(`Tool '${name}' is not registered.`);
  }

  const result = await tool.execute("test-tool-call", args, undefined, undefined, { cwd: process.cwd() });
  const textParts = Array.isArray(result?.content) ? result.content.filter((entry: any) => entry?.type === "text") : [];
  return textParts.map((entry: any) => String(entry.text ?? "")).join("\n");
}
