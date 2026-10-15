// This plugin is a deployment container for Profile/Planning and one-off
// reminders. Each owns its DB; only the routing protocol is shared.
import {registerConfirmationBackend} from '@kurumi/confirmation-core';
import {WeatherStore} from './store.js';
import {ReminderStore} from './reminder-store.js';
import {weatherStateDirectory, reminderStateDirectory} from './paths.js';

type ServiceHost = {registerService(service: {id: string; start(): void; stop(): void}): void};

export function registerDomainConfirmationBackends(api: ServiceHost): void {
  let unregisterBackends: Array<() => void> = [];
  api.registerService({
    id: "personal-domain-confirmation-backends",
    start() {
      try {
        unregisterBackends.push(registerConfirmationBackend({
          id: "profile-planning",
          open: () => new WeatherStore({ stateDirectory: weatherStateDirectory() }),
        }));
        unregisterBackends.push(registerConfirmationBackend({
          id: "personal-reminder",
          open: () => new ReminderStore({ stateDirectory: reminderStateDirectory() }),
        }));
      } catch (error) {
        for (const unregister of unregisterBackends.splice(0)) unregister();
        throw error;
      }
    },
    stop() { for (const unregister of unregisterBackends.splice(0)) unregister(); },
  });
}
