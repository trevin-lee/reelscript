const vscode = require("vscode");

function activate(context) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = "$(rocket) Acme: ready";
  status.command = "acme.deploy";
  status.show();

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand("acme.deploy", async () => {
      status.text = "$(sync~spin) Acme: deploying…";
      await new Promise((r) => setTimeout(r, 1500));
      status.text = "$(check) Acme: live";
      vscode.window.showInformationMessage("Deployed acme@1.4.0 to production.", "Open site");
    }),
  );
}

module.exports = { activate, deactivate() {} };
