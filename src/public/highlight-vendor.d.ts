declare module '*vendor/highlight/core.min.js' {
  const highlighter: {
    registerLanguage(name: string, grammar: (core: unknown) => unknown): void;
    highlight(source: string, options: { language: string; ignoreIllegals: boolean }): { value: string };
  };
  export default highlighter;
}

declare module '*vendor/highlight/javascript.min.js' {
  const grammar: (core: unknown) => unknown;
  export default grammar;
}
