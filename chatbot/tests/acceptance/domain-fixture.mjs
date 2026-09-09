import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Domain-specific fixture adapter. Nothing in production imports this file. */
export async function createDomainFixture(driver) {
  const core = await import("../../packages/confirmation-core/dist/index.js");
  const { WeatherStore } = await import("../../plugins/personal-weather/dist/store.js");
  const { ReminderStore } = await import("../../plugins/personal-weather/dist/reminder-store.js");
  const planning = await import("../../plugins/personal-weather/dist/planning.js");
  const profile = await import("../../plugins/personal-weather/dist/profile.js");
  const reminders = await import("../../plugins/personal-weather/dist/reminders.js");
  const { default: toolEntry } = await import("../../plugins/personal-weather/dist/index.js");
  const factories = new Map();
  toolEntry.register({ registrationMode: "discovery", pluginConfig: {},
    registerTool(factory, options) { factories.set(options.name, factory); } });
  const scope = core.scopeFromToolContext(driver.toolContext);
  const weatherDirectory = join(driver.directory, "state/personal-weather");
  const reminderDirectory = join(driver.directory, "state/personal-reminders");
  let clockOffset = 0;
  const now = () => Math.floor(Date.now() / 1000) + clockOffset;
  const weather = new WeatherStore({ stateDirectory: weatherDirectory, now });
  const reminder = new ReminderStore({ stateDirectory: reminderDirectory, now });
  const disposers = [
    core.registerConfirmationBackend({ id: "profile-planning", open: () => new WeatherStore({ stateDirectory: weatherDirectory, now }) }),
    core.registerConfirmationBackend({ id: "personal-reminder", open: () => new ReminderStore({ stateDirectory: reminderDirectory, now }) }),
  ];
  const schedulerCalls = [];
  const scheduler = { add: async request => { schedulerCalls.push({ operation: "add", request }); return { jobId: "acceptance-job-" + schedulerCalls.length }; },
    remove: async request => { schedulerCalls.push({ operation: "remove", request }); },
    update: async request => { schedulerCalls.push({ operation: "update", request }); } };
  const reminderContext = { delivery: { channel: "qqbot", to: "qqbot:c2c:acceptance-owner", accountId: "default" }, scope };
  return {
    core, planning, profile, reminders, scope, weather, reminder, scheduler, schedulerCalls, reminderContext,
    now, advance: seconds => { clockOffset += seconds; },
    proposal: () => planning.proposePlanningChange(weather, { schema_version: 1,
      request: { kind: "trip.create", title: "isolated acceptance", destination: { text: "南京", administrative_area: "江苏省" }, transport_mode: "rail", weather_mode: "none" } }, scope),
    commit: proposal => planning.commitPlanningProposal(weather, { proposal_id: proposal.proposalId, payload_hash: proposal.payloadHash }, scope),
    confirmation: proposal => core.buildConfirmationInstruction(proposal.proposalId, proposal.payloadHash),
    async tool(name, args, context = driver.toolContext) {
      const tool = factories.get(name)(context);
      const result = await tool.execute("acceptance-call", args);
      return JSON.parse(result.content.find(part => part.type === "text").text);
    },
    toolDefinitions(names) {
      return names.map(name => {
        const tool = factories.get(name)(driver.toolContext);
        return { name: tool.name, description: tool.description, input_schema: tool.parameters };
      });
    },
    expire(proposal) {
      // Test fixture only: expire matching proposal/grant rows without wall-clock sleeps.
      const db = new DatabaseSync(join(weatherDirectory, "weather.sqlite"));
      try {
        db.prepare("UPDATE confirmation_proposals SET expires_at_utc=created_at_utc WHERE proposal_id=?").run(proposal.proposalId);
      } finally { db.close(); }
    },
    expireGrant(proposal) {
      const db = new DatabaseSync(join(weatherDirectory, "weather.sqlite"));
      try {
        db.prepare("UPDATE approval_grants SET expires_at_utc=issued_at_utc WHERE proposal_id=?").run(proposal.proposalId);
      } finally { db.close(); }
    },
    snapshot() {
      const result = {};
      for (const [name, directory, filename] of [["profilePlanning", weatherDirectory, "weather.sqlite"], ["reminder", reminderDirectory, "reminders.sqlite"]]) {
        const db = new DatabaseSync(join(directory, filename), { readOnly: true });
        try {
          const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
          const state = {};
          for (const table of ["trips", "reminders", "change_proposals", "audit_log", "reminder_audit_log"])
            if (tables.has(table)) state[table] = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
          state.proposals = db.prepare("SELECT domain,status,count(*) AS n FROM confirmation_proposals GROUP BY domain,status ORDER BY domain,status").all();
          state.grants = db.prepare("SELECT domain,status,count(*) AS n FROM approval_grants GROUP BY domain,status ORDER BY domain,status").all();
          if (tables.has("profile_current_location")) state.profileRevision = db.prepare("SELECT revision FROM profile_current_location").get().revision;
          result[name] = state;
        } finally { db.close(); }
      }
      return JSON.parse(JSON.stringify(result));
    },
    close() { for (const dispose of disposers) dispose(); weather.close(); reminder.close(); },
  };
}
