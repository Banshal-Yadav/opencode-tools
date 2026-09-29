// Minimal local ambient declaration so `tsc --noEmit` can typecheck the tool
// sources without the real @opencode-ai/plugin package installed.
declare module "@opencode-ai/plugin" {
  export interface SchemaType {
    optional(): SchemaType;
    nullable(): SchemaType;
    default(value: unknown): SchemaType;
    describe(text: string): SchemaType;
    array(): SchemaType;
    min(n: number): SchemaType;
    max(n: number): SchemaType;
    [key: string]: unknown;
  }

  export interface ToolSchema {
    string(): SchemaType;
    number(): SchemaType;
    boolean(): SchemaType;
    enum(values: readonly string[]): SchemaType;
    array(item: SchemaType): SchemaType;
    object(shape: Record<string, SchemaType>): SchemaType;
  }

  export interface ToolContext {
    [key: string]: unknown;
  }

  export interface Tool {
    description: string;
    args: Record<string, SchemaType>;
    execute(args: any, context?: any): any;
  }

  export function tool<T extends Tool>(definition: T): T;

  export namespace tool {
    const schema: ToolSchema;
  }
}