import { createBrowserAdapter } from "./browser-adapter.js";
import { createBackgroundController } from "./controller.js";

const api = browser;
const adapter = createBrowserAdapter(api);

createBackgroundController({ api, adapter });
