// Same weather parsers/profile semantics, with provider I/O owned by KnowledgeMap.
import { KnowledgeMapClient, BridgeError } from "../../../packages/knowledgemap-client/client.js";
import type { Coordinates, GeoLookupInput, WeatherClient } from "./qweather-client.js";
import { WeatherError } from "./errors.js";

export class KnowledgeMapWeatherClient implements WeatherClient {
  readonly #client: KnowledgeMapClient;
  readonly #runId: string | undefined;
  constructor(config: { baseUrl?: string | undefined; tokenFile?: string | undefined; runId?: string | undefined }) {
    this.#runId = config.runId;
    this.#client = new KnowledgeMapClient({
      ...(config.baseUrl ? {baseUrl: config.baseUrl} : {}),
      ...(config.tokenFile ? {tokenFile: config.tokenFile} : {}),
    });
  }
  async #get(component: string, query: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.#client.request(`/api/assistant/weather/${component}`, {query, ...(this.#runId ? {runId: this.#runId} : {}), ...(signal ? {signal} : {})});
    } catch (error) {
      if (signal?.aborted) throw new WeatherError("REQUEST_CANCELLED");
      if (error instanceof BridgeError && error.status === 401) throw new WeatherError("AUTH_FAILED");
      if (error instanceof BridgeError && error.status === 403) throw new WeatherError("FORBIDDEN");
      throw new WeatherError("UPSTREAM_UNAVAILABLE", {retryable: true});
    }
  }
  getCurrent(coordinates: Coordinates, signal?: AbortSignal) {return this.#get("current", {...coordinates}, signal);}
  getDaily(coordinates: Coordinates, signal?: AbortSignal) {return this.#get("daily", {...coordinates}, signal);}
  getHourly(coordinates: Coordinates, signal?: AbortSignal) {return this.#get("hourly", {...coordinates}, signal);}
  getAlerts(coordinates: Coordinates, signal?: AbortSignal) {return this.#get("alerts", {...coordinates}, signal);}
  lookupPlace(input: GeoLookupInput, signal?: AbortSignal) {return this.#get("lookup", {...input}, signal);}
}
