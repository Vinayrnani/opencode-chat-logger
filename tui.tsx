import type { TuiPlugin, TuiDialogSelectOption } from "@opencode-ai/plugin/tui";

export default (async (api) => {
  const fs = await import("fs");
  const path = await import("path");

  const chatDir = () => path.join(api.state.path.directory, ".opencode", "chats");

  api.ui.toast({ title: "chat-logger", message: "TUI plugin loaded — /read-chat and /read-n available" });

  api.keymap.registerLayer({
    commands: [
      {
        id: "chat-logger.read-chat",
        title: "Read Chat",
        description: "Restore a saved chat log into current session context",
        execute: async () => {
          let files: string[] = [];
          try { files = fs.readdirSync(chatDir()).filter((f: string) => f.endsWith(".md")); } catch {}

          if (!files.length) {
            api.ui.toast({ title: "No saved chats", message: "No chat logs found in .opencode/chats/" });
            return;
          }

          const current = api.route.current;
          const sessionID = current.name === "session" ? current.params.sessionID : "";

          let picked = false;

          const options: TuiDialogSelectOption<string>[] = files.map((f: string) => {
            const title = f.replace(/\.md$/, "");
            return {
              title,
              value: title,
              onSelect: async () => {
                picked = true;
                try {
                  await api.client.session.command({
                    sessionID,
                    command: "read-chat",
                    arguments: title,
                    directory: api.state.path.directory,
                  });
                  api.ui.toast({ title: "Restored", message: title });
                } catch {
                  api.ui.toast({ title: "Failed", message: `Could not restore "${title}"` });
                }
              },
            };
          });

          api.ui.dialog.replace(
            () => (
              <api.ui.DialogSelect
                title="Select chat to restore"
                placeholder="Search chats..."
                options={options}
              />
            ),
            () => {
              if (picked) return;
              api.client.session.command({
                sessionID,
                command: "read-chat",
                arguments: "",
                directory: api.state.path.directory,
              }).then(() => {
                api.ui.toast({ title: "Restored", message: "Current session chat" });
              }).catch(() => {});
            }
          );
        },
      },
      {
        id: "chat-logger.read-n",
        title: "Read N",
        description: "Restore recent N user+assistant exchanges into context",
        execute: () => {
          api.ui.toast({ title: "/read-n", message: "Usage: /read-n <number> (e.g., /read-n 10)" });
        },
      },
    ],
    bindings: [],
  });
}) satisfies TuiPlugin;
