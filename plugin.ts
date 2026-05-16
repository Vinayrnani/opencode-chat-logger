import type { Plugin } from "@opencode-ai/plugin";
import fs from "fs";

function sanitize(title: string): string {
  return title.replace(/[/\\?%*:|"<>]/g, "-").replace(/\s+/g, " ").trim() || "Untitled";
}

function uniquePath(dir: string, base: string): { path: string; slug: string } {
  const safe = sanitize(base);
  let slug = safe;
  let n = 1;
  while (fs.existsSync(`${dir}/${slug}.md`)) {
    slug = `${safe} (${n})`;
    n++;
  }
  return { path: `${dir}/${slug}.md`, slug };
}

function ts(t: number): string {
  return new Date(t).toISOString().replace("T", " ").slice(0, 19);
}

function renderMessages(
  msgs: Array<{ id?: string; info: { role: string }; parts: Array<{ type: string; text?: string }> }>
): string {
  const out: string[] = [];
  for (const m of msgs) {
    if (m.info.role === "user") {
      const text = m.parts.filter((p) => p.type === "text").map((p) => p.text || "").join("\n");
      if (text) out.push(`## User\n\n${text}\n`);
    } else if (m.info.role === "assistant") {
      const texts = m.parts.filter((p) => p.type === "text").map((p) => p.text || "").filter(Boolean);
      if (texts.length) out.push(`## Assistant\n\n${texts.join("\n")}\n`);
    }
  }
  return out.join("\n---\n\n");
}

function parseExchanges(content: string): Array<{ role: string; text: string }> {
  const blocks = content.split(/^## (User|Assistant)$/m);
  const exchanges = [];
  for (let i = 1; i < blocks.length; i += 2) {
    const role = blocks[i]?.toLowerCase() || "";
    const text = blocks[i + 1]?.trim() || "";
    if (text && (role === "user" || role === "assistant")) {
      exchanges.push({ role, text });
    }
  }
  return exchanges;
}

function countExchangesInFile(path: string): number {
  if (!fs.existsSync(path)) return 0;
  const content = fs.readFileSync(path, "utf-8");
  const matches = content.match(/^## (User|Assistant)$/gm);
  return matches ? matches.length : 0;
}

export default (async ({ client, directory, $ }) => {
  const chatDir = `${directory}/.opencode/chats`;
  const commandsDir = `${directory}/.opencode/commands`;
  await $`mkdir -p ${chatDir}`.nothrow();
  await $`mkdir -p ${commandsDir}`.nothrow();

  const commandFiles: Record<string, string> = {
    "read-chat.md": `# Restore a saved chat log into current session context

Browse saved chats by number, or restore by title.

Usage: \`/read-chat\` (list), \`/read-chat <number>\` (by index), or \`/read-chat <title>\`
`,
    "read-n.md": `# Restore recent N user+assistant exchanges into context

Number of exchanges: $ARGUMENTS
`,
  };

  for (const [name, content] of Object.entries(commandFiles)) {
    try { fs.writeFileSync(`${commandsDir}/${name}`, content, "utf-8"); } catch (e) { console.error("[chat-logger] write command file error:", e); }
  }

  let currentTitle: string | null = null;
  const chatFiles = new Map<string, string>();
  const messageCounts = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  async function flush(title: string, sessionId: string) {
    const path = chatFiles.get(title);
    if (!path) return;
    try {
      const res = await client.session.messages({ path: { id: sessionId }, query: { directory } });
      const msgs = res.data || [];
      if (!msgs.length) return;

      const existingCount = messageCounts.get(title) ?? countExchangesInFile(path);
      const newMsgs = msgs.slice(existingCount);
      if (newMsgs.length === 0) return;

      const content = renderMessages(newMsgs as Array<any>);
      if (!content.trim()) return;

      const fileExists = fs.existsSync(path);
      if (!fileExists) {
        fs.writeFileSync(path, `# ${title}\n\n_Created: ${ts(Date.now())}_\n\n${content}`, "utf-8");
      } else {
        fs.appendFileSync(path, `\n\n${content}`, "utf-8");
      }

      messageCounts.set(title, existingCount + newMsgs.length);
    } catch (e) {
      console.error("[chat-logger] flush error:", e);
    }
  }

  function defer(title: string, sessionId: string, ms = 2000) {
    const t = timers.get(title);
    if (t) clearTimeout(t);
    timers.set(title, setTimeout(() => { timers.delete(title); flush(title, sessionId); }, ms));
  }

  const pendingContext = new Map<string, string>();

  function commandResult(text: string): any {
    return [{ type: "text" as const, text }];
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.created" || event.type === "session.updated") {
        const info = event.properties.info;
        const title = info?.title || "Untitled";
        const { path } = uniquePath(chatDir, title);
        currentTitle = title;
        chatFiles.set(title, path);
      } else if (event.type === "message.updated" || event.type === "message.part.updated") {
        if (!currentTitle) return;
        const props = event.properties as any;
        const sessionId = props.sessionID || props.info?.sessionID || props.message?.sessionID;
        if (sessionId) {
          defer(currentTitle, sessionId, 1500);
        }
      } else if (event.type === "session.idle") {
        if (!currentTitle) return;
        const { sessionID } = event.properties;
        const t = timers.get(currentTitle);
        if (t) clearTimeout(t);
        timers.delete(currentTitle);
        await flush(currentTitle, sessionID);
      }
    },

    "command.execute.before": async (input, output) => {
      if (input.command === "read-chat") {
        const q = input.arguments.trim();
        let files: string[] = [];
        try { files = fs.readdirSync(chatDir).filter((f: string) => f.endsWith(".md")); } catch (e) { console.error("[chat-logger] readdir error:", e); }

        function numberedList(prefix?: string): string {
          const lines = files.map((f, i) => `  ${i + 1}. ${f.replace(/\.md$/, "")}`);
          const header = prefix ? `${prefix}\n\n` : "";
          return files.length
            ? `${header}Available chats:\n${lines.join("\n")}\n\nUsage: /read-chat <number|title>`
            : "No saved chats yet.";
        }

        if (!q) {
          output.parts = commandResult(numberedList());
          return;
        }

        const n = parseInt(q, 10);
        let match: string | undefined;

        if (!isNaN(n) && n >= 1 && n <= files.length) {
          match = files[n - 1];
        } else {
          match = files.find((f) =>
            f.replace(/\.md$/, "").toLowerCase() === q.toLowerCase()
          );
        }

        if (!match) {
          output.parts = commandResult(numberedList(`Chat "${q}" not found.`));
          return;
        }

        const content = fs.readFileSync(`${chatDir}/${match}`, "utf-8").trim();
        if (content) {
          pendingContext.set(input.sessionID, content);
          output.parts = commandResult(`✅ Restored: ${match.replace(/\.md$/, "")}`);
        } else {
          output.parts = commandResult(`Chat "${q}" is empty.`);
        }
        return;
      }

      if (input.command === "read-n") {
        const n = parseInt(input.arguments.trim(), 10);
        if (isNaN(n) || n < 1) {
          output.parts = commandResult("Usage: /read-n <number> (e.g., /read-n 10)");
          return;
        }

        if (!currentTitle) {
          output.parts = commandResult("No active session. Start a chat first.");
          return;
        }

        const files = fs.readdirSync(chatDir).filter((f: string) => f.endsWith(".md"));
        const safeTitle = sanitize(currentTitle);
        const match = files.find((f: string) =>
          f.replace(/\.md$/, "").startsWith(safeTitle) ||
          f.replace(/\.md$/, "").startsWith(currentTitle)
        );

        if (!match) {
          output.parts = commandResult(`No saved chat found for "${currentTitle}". Chat not yet saved.`);
          return;
        }

        try {
          const content = fs.readFileSync(`${chatDir}/${match}`, "utf-8");
          const exchanges = parseExchanges(content);
          const lastN = exchanges.slice(-n * 2);

          if (lastN.length > 0) {
            const formatted = lastN.map(e => ({
              info: { role: e.role },
              parts: [{ type: "text" as const, text: e.text }]
            }));
            pendingContext.set(input.sessionID, renderMessages(formatted));
            output.parts = commandResult(`Restored last ${n} exchanges from "${match.replace(/\.md$/, "")}"`);
          } else {
            output.parts = commandResult("No exchanges found in saved chat.");
          }
        } catch (e) {
          console.error("[chat-logger] read-n error:", e);
          output.parts = commandResult("Failed to read saved chat.");
        }
        return;
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      const ctx = pendingContext.get(input.sessionID);
      if (!ctx) return;
      pendingContext.delete(input.sessionID);
      output.system.push(
        `\n<restored-conversation>\n${ctx}\n</restored-conversation>\n`
      );
    },
  };
}) satisfies Plugin;
