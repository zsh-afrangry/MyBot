import { Type } from 'typebox';
const secretRefSchema = Type.Object({
    source: Type.Literal("env"),
    provider: Type.Literal("default"),
    id: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
export const geoConfigSchema = Type.Object({
    scheduledOwnerId: Type.Optional(Type.String()),
    weatherBackend: Type.Optional(Type.Union([Type.Literal("qweather"), Type.Literal("knowledgemap")])),
    bridgeBaseUrl: Type.Optional(Type.String()),
    bridgeTokenFile: Type.Optional(Type.String()),
    apiHost: Type.String({
        description: "QWeather dedicated API hostname without scheme or path.",
    }),
    apiKey: Type.Union([Type.String(), secretRefSchema]),
}, { additionalProperties: false });
