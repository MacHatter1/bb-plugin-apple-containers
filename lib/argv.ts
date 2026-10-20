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
      if (next !== "\n") word += next;
      started = true;
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
