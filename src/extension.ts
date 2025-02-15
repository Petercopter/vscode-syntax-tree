"use strict";

import { exec } from "child_process";
import * as fs from "fs";
import { promisify } from "util";
import { ExtensionContext, commands, window, workspace } from "vscode";
import { LanguageClient, ServerOptions } from "vscode-languageclient/node";

import * as variables from "./variables";
import Visualize from "./Visualize";

const promiseExec = promisify(exec);

// This object will get initialized once the language client is ready. It will
// get set back to null when the extension is deactivated. It is exported for
// easier testing.
export let languageClient: LanguageClient | null = null;

// This is the expected top-level export that is called by VSCode when the
// extension is activated.
export async function activate(context: ExtensionContext) {
  // This output channel is going to contain all of our informational messages.
  // It's not really meant for the end-user, it's more for debugging.
  const outputChannel = window.createOutputChannel("Syntax Tree");

  // This object will get initialized once the language client is ready.
  let visualizer: Visualize | null = null;

  // This is the list of objects that implement the Disposable interface. They
  // will all get cleaned up with this extension is deactivated. It's important
  // to add them to this list so we don't leak memory.
  context.subscriptions.push(
    // The output channel itself is a disposable. When the extension is
    // deactivated it will be removed from the list.
    outputChannel,

    // Each of the commands that interacts with this extension is a disposable.
    // It's important to register them here as opposed to whenever the client
    // starts up because we don't want to register them again whenever the
    // client restarts.
    commands.registerCommand("syntaxTree.start", startLanguageServer),
    commands.registerCommand("syntaxTree.stop", stopLanguageServer),
    commands.registerCommand("syntaxTree.restart", restartLanguageServer),
    commands.registerCommand("syntaxTree.visualize", () => visualizer?.visualize()),
    commands.registerCommand("syntaxTree.showOutputChannel", () => outputChannel.show()),
    workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("syntaxTree")) {
        restartLanguageServer();
      }
    })
  );

  // If there's an open folder, use it as cwd when spawning commands
  // to promote correct package & language versioning.
  const getCWD = () => workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd();

  // This function is called when the extension is activated or when the
  // language server is restarted.
  async function startLanguageServer() {
    if (languageClient) {
      return; // preserve idempotency
    }

    // The top-level configuration group is syntaxTree. Broadly useful settings
    // are under that group.
    const config = workspace.getConfiguration("syntaxTree");
    // More obscure settings for power users live in a subgroup.
    const advancedConfig = workspace.getConfiguration("syntaxTree.advanced");

    // The args are going to be passed to the stree executable. It's important
    // that it lines up with what the CLI expects.
    const args = ["lsp"];
    const plugins = new Set<string>();

    if (config.get<boolean>("singleQuotes")) {
      plugins.add("plugin/single_quotes");
    }

    if (config.get<boolean>("trailingComma")) {
      plugins.add("plugin/trailing_comma");
    }

    const additionalPlugins = config.get<string[]>("additionalPlugins");
    if (additionalPlugins) {
      additionalPlugins.forEach(plugin => plugins.add(plugin));
    }

    // If there are any plugins, then we'll pass the --plugins command line
    // option to the stree lsp command.
    if (plugins.size > 0) {
      args.push(`--plugins=${Array.from(plugins).join(",")}`);
    }

    // Configure print width.
    const printWidth = config.get<number>("printWidth");
    if (printWidth) {
      args.push(`--print-width=${printWidth}`);
    }

    // There's a bit of complexity here. Basically, we try to locate
    // an stree executable in three places, in order of preference:
    //   1. Explicit path from advanced settings, if provided
    //   2. The bundle inside CWD, if syntax_tree is in the bundle
    //   3. Anywhere in $PATH (i.e. system gem)
    //
    // None of these approaches is perfect. System gem might be correct if the
    // right environment variables are set, but it's a bit of a prayer. Bundled
    // gem is better, but we make the gross oversimplification that the
    // workspace only has one root and that the bundle is at root of the
    // workspace -- which is not true for large projects or monorepos.
    // Explicit path varies between machines/users and is also victim to the
    // oversimplification problem.
    let run: ServerOptions = { command: "stree", args };
    let commandPath = advancedConfig.get<string>("commandPath");
    if (commandPath) {
      commandPath = variables.substitute(commandPath);
      try {
        if (fs.statSync(commandPath).isFile()) {
          run = { command: commandPath, args };
        }
      } catch (err) {
        outputChannel.appendLine(`Ignoring bogus commandPath (${commandPath} does not exist); falling back to global.`);
      }
    } else {
      try {
        const cwd = getCWD();
        await promiseExec("bundle show syntax_tree", { cwd });
        run = { command: "bundle", args: ["exec", "stree"].concat(args), options: { cwd } };
      } catch {
        // No-op (just keep using the global stree)
      }
    }

    outputChannel.appendLine(`Starting language server: ${run.command} ${run.args?.join(" ")}`);

    // Here, we instantiate the language client. This is the object that is
    // responsible for the communication and management of the Ruby subprocess.
    languageClient = new LanguageClient("Syntax Tree", { run, debug: run }, {
      documentSelector: [
        { scheme: "file", language: "haml" },
        { scheme: "file", language: "ruby" },
        { scheme: "file", pattern: "**/Gemfile" },
      ],
      outputChannel
    });

    try {
      // Here we're going to wait for the language server to start.
      await languageClient.start();
      // Finally, now that the language server has been properly started, we can
      // add the various features to the extension. Each of them in turn
      // implements Disposable so that they clean up their own resources.
      visualizer = new Visualize(languageClient, outputChannel);
      context.subscriptions.push(visualizer);
    } catch (error) {
      languageClient = null;

      const items = ["Restart"];
      let msg = "Something went wrong.";

      if (typeof error === "string") {
        if (/ENOENT/.test(error)) {
          msg = "Command not found. Is the syntax_tree gem installed?";
          items.unshift("Install Gem");
        }
      }

      const action = await window.showErrorMessage(msg, ...items);
      switch (action) {
        case "Install Gem":
          installGem();
          break;
        case "Restart":
          startLanguageServer();
          break;
      }
    }
  }

  // This function is called as part of the shutdown or restart process. It's
  // always user-initiated either through manually executing an action or
  // changing some configuration.
  async function stopLanguageServer() {
    if (languageClient) {
      outputChannel.appendLine("Stopping language server...");
      await languageClient.stop();
      languageClient = null;
    }
  }

  // This function is called as part of the restart process. Like
  // stopLanguageServer, it's always user-initiated either through manually
  // executing an action or changing some configuration.
  async function restartLanguageServer() {
    outputChannel.appendLine("Restarting language server...");
    await stopLanguageServer();
    await startLanguageServer();
  }

  // This function is called when the user wants to recover from ENOENT
  // on start. It starts the language server afterward.
  async function installGem() {
    try {
      await promiseExec("gem install syntax_tree", { cwd: getCWD() });
      startLanguageServer();
    } catch (error) {
      outputChannel.appendLine(`Error installing gem: ${error}`);
    }
  }

  // We're returning a Promise from this function that will start the Ruby
  // subprocess.
  await startLanguageServer();
}

// This is the expected top-level export that is called by VSCode when the
// extension is deactivated.
export async function deactivate() {
  await languageClient?.stop();
  languageClient = null;
}
