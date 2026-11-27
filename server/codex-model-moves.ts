import type { ModelCatalog } from "./contracts.ts";
import { codexListedModel } from "./drivers/codex-catalog.ts";
import type { BotRecord, Store, TaskPatch } from "./store.ts";

type Engine = { instanceId: string; driverKind: string; models: ModelCatalog };
type Bots = Pick<Store, "bots" | "patchBot" | "patchTask">;

/** Bots and conversations saved on a Codex model the catalog now lists under its config's own provider move to that row
 * (codexListedModel), so they keep answering and never read as unavailable. Returns how many moved. */
export function moveCodexModels(store: Bots, engines: readonly Engine[]): number {
  let moved = 0;
  for (const engine of engines) {
    if (engine.driverKind !== "codex") continue;
    const renamed = (selection: BotRecord["modelSelection"] | undefined) => {
      if (selection?.instanceId !== engine.instanceId) return undefined;
      const model = codexListedModel(engine.models, selection.model);
      return model ? { ...selection, model } : undefined;
    };
    for (const bot of store.bots) {
      const own = renamed(bot.modelSelection);
      if (own) { store.patchBot(bot.id, { modelSelection: own }); moved += 1; }
      for (const task of bot.tasks ?? []) {
        const modelSelection = renamed(task.modelSelection);
        if (modelSelection) { store.patchTask(bot.id, task.threadId, { modelSelection } satisfies TaskPatch); moved += 1; }
      }
    }
  }
  return moved;
}
