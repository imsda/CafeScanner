declare module 'json2csv' {
  export interface ParserOptions<T> {
    fields?: string[];
  }

  export class Parser<T = Record<string, unknown>> {
    constructor(options?: ParserOptions<T>);
    parse(data: T[]): string;
  }
}
