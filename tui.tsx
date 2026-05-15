import type { TuiPlugin, TuiDialogSelectOption } from "@opencode-ai/plugin/tui";

export default (async (api) => {
  const fs = await import("fs");
  const path = await import("path");

  const chatDir = () => path.join(api.state.path.directory, ".opencode", "chats");

  api.ui.toast({ title: "chat-logger", message: "TUI plugin loaded — /read-chat and /read-n available" });

  api.command?.register(() => [
    {
      title: "Read Chat",
      value: "read-chat",
      description: "Restore a saved chat log into current session context",
      slash: { name: "read-chat" },
      onSelect: async (dialog) => {
        let files: string[] = [];
        try { files = fs.readdirSync(chatDir()).filter((f: string) => f.endsWith(".md")); } catch {}

        if (!files.length || !dialog) {
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

        dialog.replace(
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
      title: "Read N",
      value: "read-n",
      description: "Restore recent N user+assistant exchanges into context",
      slash: { name: "read-n" },
      onSelect: () => {
        api.ui.toast({ title: "/read-n", message: "Usage: /read-n <number> (e.g., /read-n 10)" });
      },
    },
  ]);
}) satisfies TuiPlugin;