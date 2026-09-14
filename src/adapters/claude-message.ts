/** Claude's native peer envelope supplies attribution without claiming human authority. */
export function claudePeerMessage(prompt: string) {
  const body = prompt.replace(/<(?=\s*\/\s*cross-session-message\b)/gi, "<\\");
  return `<cross-session-message from="switchboard" from-name="Switchboard">\n${body}\n</cross-session-message>`;
}
