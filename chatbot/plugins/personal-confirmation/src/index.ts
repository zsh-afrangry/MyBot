import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { confirmationBackendIds, recordRegisteredConfirmation } from "@kurumi/confirmation-core";
import { confirmationFromDispatch } from "./inbound.js";

// Runtime API supports this hook; this installed SDK omits `on` from the base
// declaration. Keep the compatibility surface narrow and validate on the host.
type ConfirmationHookApi = OpenClawPluginApi & {
  on(name: "reply_dispatch", handler: (event: Parameters<typeof confirmationFromDispatch>[0]) => void): void;
};

const personalConfirmationPlugin: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "personal-confirmation",
  name: "Personal Confirmation",
  description: "Shared confirmation ingress; business storage and commits stay with their domains.",
  register(api) {
    (api as ConfirmationHookApi).on("reply_dispatch", (event) => {
      const inbound = confirmationFromDispatch(event);
      if (!inbound) return;
      recordRegisteredConfirmation(inbound, diagnostic => {
        const message = JSON.stringify({ component: "personal-confirmation", ...diagnostic });
        if (diagnostic.outcome === "storage_error" || diagnostic.outcome === "no_backends") api.logger.warn(message);
        else api.logger.info(message);
      });
      // Returning void lets the default model turn call its authorized commit tool.
    });
    api.registerService({
      id: "personal-confirmation-health",
      start() { api.logger.info(JSON.stringify({ component: "personal-confirmation", event: "started", backends: confirmationBackendIds() })); },
    });
  },
});

export default personalConfirmationPlugin;
