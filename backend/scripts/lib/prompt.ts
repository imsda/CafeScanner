import readline from 'readline';

function askLine(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function promptText(label: string): Promise<string> {
  return askLine(label);
}

export async function promptHidden(label: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;

  if (!input.isTTY || !output.isTTY) {
    throw new Error('Interactive TTY is required for hidden input');
  }

  output.write(label);

  const previousRawMode = input.isRaw;
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');

  return new Promise<string>((resolve, reject) => {
    let value = '';

    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode(Boolean(previousRawMode));
      output.write('\n');
    };

    const onData = (chunk: string) => {
      if (chunk === '\u0003') {
        cleanup();
        reject(new Error('Cancelled'));
        return;
      }

      if (chunk === '\r' || chunk === '\n') {
        cleanup();
        resolve(value.trim());
        return;
      }

      if (chunk === '\u0008' || chunk === '\u007f') {
        value = value.slice(0, -1);
        return;
      }

      value += chunk;
    };

    input.on('data', onData);
  });
}

export async function confirmExact(label: string, requiredPhrase: string): Promise<void> {
  const value = await promptText(label);
  if (value !== requiredPhrase) {
    throw new Error('Confirmation mismatch');
  }
}
