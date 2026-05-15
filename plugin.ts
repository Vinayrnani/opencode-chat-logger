import type { Plugin } from "@opencode-ai/plugin";

const fs = require("fs");

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

export default (async ({ client, directory, $ }) => {
  const chatDir = `${directory}/.opencode/chats`;
  await $`mkdir -p ${chatDir}`.nothrow();

  const sessions = new Map<string, { title: string; slug: string; path: string }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const writtenIds = new Map<string, Set<string>>();

  async function flush(id: string) {
    const s = sessions.get(id);
    if (!s) return;
    try {
      const res = await client.session.messages({ path: { id }, query: { directory } });
      const msgs = res.data || [];
      if (!msgs.length) return;

      let existing = writtenIds.get(id);
      const fileExists = fs.existsSync(s.path);

      if (!existing && fileExists) {
        existing = new Set(msgs.filter((m: any) => m.id).map((m: any) => m.id));
        writtenIds.set(id, existing);
        return;
      }

      if (!existing) existing = new Set();

      const newMsgs = msgs.filter((m: any) => m.id && !existing!.has(m.id));
      if (!newMsgs.length) return;

      const content = renderMessages(newMsgs);
      if (!content.trim()) return;

      if (!fileExists) {
        fs.writeFileSync(s.path, `# ${s.title}\n\n_Created: ${ts(Date.now())}_\n\n${content}`, "utf-8");
      } else {
        fs.appendFileSync(s.path, `\n\n${content}`, "utf-8");
      }

      for (const m of newMsgs) {
        if (m.id) existing!.add(m.id);
      }
      writtenIds.set(id, existing!);
    } catch {}
  }

  function defer(id: string, ms = 2000) {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.set(id, setTimeout(() => { timers.delete(id); flush(id); }, ms));
  }

  const pendingContext = new Map<string, string>();

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const info = event.properties.info;
        const title = info.title || "Untitled";
        const { path, slug } = uniquePath(chatDir, title);
        sessions.set(info.id, { title, slug, path });
      } else if (event.type === "session.updated") {
        const info = event.properties.info;
        const existing = sessions.get(info.id);
        if (!existing) {
          const title = info.title || "Untitled";
          const { path, slug } = uniquePath(chatDir, title);
          sessions.set(info.id, { title, slug, path });
        } else if (info.title && info.title !== existing.title) {
          const { path, slug } = uniquePath(chatDir, info.title);
          const old = existing.path;
          existing.title = info.title;
          existing.slug = slug;
          existing.path = path;
          if (old !== path && fs.existsSync(old)) {
            try { fs.renameSync(old, path); } catch {}
          }
        }
      } else if (event.type === "message.updated") {
        const sid = (event.properties as any).info?.sessionID;
        if (sid && sessions.has(sid)) defer(sid, 1500);
      } else if (event.type === "message.part.updated") {
        const sid = (event.properties as any).part?.sessionID;
        if (sid && sessions.has(sid)) defer(sid, 1500);
      } else if (event.type === "session.idle") {
        const { sessionID } = event.properties;
        if (sessionID && sessions.has(sessionID)) {
          const t = timers.get(sessionID);
          if (t) clearTimeout(t);
          timers.delete(sessionID);
          await flush(sessionID);
        }
      }
    },

    "command.execute.before": async (input, output) => {
      if (input.command === "read-chat") {
        const q = input.arguments.trim();
        let files: string[] = [];
        try { files = fs.readdirSync(chatDir).filter((f: string) => f.endsWith(".md")); } catch {}

        if (!q) {
          const sess = sessions.get(input.sessionID);
          const defaultTitle = sess ? sess.title : null;

          if (defaultTitle) {
            const match = files.find((f: string) =>
              f.replace(/\.md$/, "").toLowerCase() === defaultTitle.toLowerCase()
            );
            if (match) {
              const content = fs.readFileSync(`${chatDir}/${match}`, "utf-8").trim();
              if (content) {
                pendingContext.set(input.sessionID, content);
                output.parts = [{ type: "text", text: `✅ Restored: ${defaultTitle}` }];
                return;
              }
            }
          }

          const list = files.map((f: string, i: number) => `  ${i + 1}. ${f.replace(/\.md$/, "")}`).join("\n");
          output.parts = [{
            type: "text",
            text: list
              ? `Available chats:\n${list}\n\nUsage: /read-chat <title> (no args restores current session)`
              : "No saved chats yet.",
          }];
          return;
        }

        const match = files.find((f: string) =>
          f.replace(/\.md$/, "").toLowerCase() === q.toLowerCase()
        );
        if (!match) {
          const list = files.map((f: string, i: number) => `  ${i + 1}. ${f.replace(/\.md$/, "")}`).join("\n");
          output.parts = [{
            type: "text",
            text: list
              ? `Chat "${q}" not found.\nAvailable chats:\n${list}`
              : `Chat "${q}" not found. No saved chats yet.`,
          }];
          return;
        }

        const content = fs.readFileSync(`${chatDir}/${match}`, "utf-8").trim();
        if (content) {
          pendingContext.set(input.sessionID, content);
          output.parts = [{ type: "text", text: `✅ Restored: ${match.replace(/\.md$/, "")}` }];
        } else {
          output.parts = [{ type: "text", text: `Chat "${q}" is empty.` }];
        }
        return;
      }

      if (input.command === "read-n") {
        const n = parseInt(input.arguments.trim(), 10);
        if (isNaN(n) || n < 1) {
          output.parts = [{ type: "text", text: "Usage: /read-n <number> (e.g., /read-n 10)" }];
          return;
        }
        try {
          const res = await client.session.messages({ path: { id: input.sessionID }, query: { directory } });
          const msgs = res.data || [];
          const exchanges = msgs.filter((m: any) =>
            m.info?.role === "user" || m.info?.role === "assistant"
          );
          const lastN = exchanges.slice(-n * 2);
          const content = renderMessages(lastN);
          if (content.trim()) {
            pendingContext.set(input.sessionID, content);
            output.parts = [{ type: "text", text: `✅ Restored last ${n} exchanges` }];
          } else {
            output.parts = [{ type: "text", text: "No messages to restore." }];
          }
        } catch {
          output.parts = [{ type: "text", text: "Failed to retrieve session messages." }];
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
