/** Tokenise a command field like a shell, without executing expansions or a shell. */
export function parseCommand(text: string): string[] {
  const values: string[] = [];
  let word = "",
    quote = "",
    started = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "\\" && quote !== "'") {
      const next = text[++i];
      if (next === undefined)
        throw new Error("Finish the escape at the end of the command.");
      if (quote === '"' && !['"', "\\", "$", "`", "\n"].includes(next))
        word += "\\";
      // A backslash-newline is a line continuation: it adds nothing, not even
      // an empty word.
      if (next !== "\n") {
        word += next;
        started = true;
      }
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        values.push(word);
        word = "";
        started = false;
      }
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new Error("Close the quote in the command.");
  if (started) values.push(word);
  return values;
}

/** Show argv as a copyable command line, quoting only arguments that need it. */
export const formatCommand = (argv: string[]) =>
  argv
    .map((v) =>
      /^[\w./:=@,+-]+$/.test(v) ? v : `'${v.replaceAll("'", "'\\''")}'`,
    )
    .join(" ");

/** The same command over several lines, one flag and its value per line with
 * shell continuations, so long runs stay readable and still paste cleanly. */
export function formatCommandLines(argv: string[], valueless = ["--detach"]) {
  const lines: string[][] = [];
  let i = 0;
  const head = [argv[i++]];
  while (argv[i] !== undefined && valueless.includes(argv[i]!))
    head.push(argv[i++]!);
  lines.push(head.filter((v): v is string => v !== undefined));
  while (argv[i]?.startsWith("--")) {
    const flag = argv[i++]!;
    lines.push(
      valueless.includes(flag) || argv[i] === undefined
        ? [flag]
        : [flag, argv[i++]!],
    );
  }
  if (i < argv.length) lines.push(argv.slice(i));
  return lines.map((line) => formatCommand(line)).join(" \\\n  ");
}
