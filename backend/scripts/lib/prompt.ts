import readline from 'readline';

export type Prompt = {
  ask: (query: string) => Promise<string>;
  askHidden: (query: string) => Promise<string>;
  close: () => void;
};

export function createPrompt(): Prompt {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const ask = (query: string) =>
    new Promise<string>((resolve) => {
      rl.question(query, (answer) => resolve(answer.trim()));
    });

  const askHidden = (query: string) =>
    new Promise<string>((resolve, reject) => {
      const input = process.stdin;
      const output = process.stdout;

      if (!input.isTTY || !output.isTTY) {
        reject(new Error('Interactive TTY is required for hidden input'));
        return;
      }

      rl.pause();
      output.write(query);

      const wasRaw = input.isRaw;
      input.setRawMode(true);
      input.resume();
      input.setEncoding('utf8');

      let value = '';

      const cleanup = () => {
        input.removeListener('data', onData);
        input.setRawMode(Boolean(wasRaw));
        output.write('\n');
        rl.resume();
      };

      const onData = (chunk: string) => {
        if (chunk === '\r' || chunk === '\n') {
          cleanup();
          resolve(value.trim());
          return;
        }

        if (chunk === '\u0003') {
          cleanup();
          reject(new Error('Cancelled'));
          return;
        }

        if (chunk === '\u007f' || chunk === '\b' || chunk === '\x08') {
          value = value.slice(0, -1);
          return;
        }

        value += chunk;
      };

      input.on('data', onData);
    });

  return {
    ask,
    askHidden,
    close: () => rl.close(),
  };
}
