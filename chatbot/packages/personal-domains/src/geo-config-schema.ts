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

export const profileCatalogEntrySchema = Type.Object({
    id: Type.String({pattern: '^[a-z0-9][a-z0-9._-]{0,63}$'}),
    name: Type.String({minLength: 1, maxLength: 80}),
    countryCode: Type.String({pattern: '^[A-Z]{2}$'}),
    adm1: Type.Optional(Type.String({minLength: 1, maxLength: 50})),
    adm2: Type.Optional(Type.String({minLength: 1, maxLength: 50})),
    latitude: Type.Number({minimum: -90, maximum: 90}),
    longitude: Type.Number({minimum: -180, maximum: 180}),
    timezone: Type.String({minLength: 1, maxLength: 100}),
    precision: Type.Union([Type.Literal('city'), Type.Literal('district'), Type.Literal('point')]),
}, {additionalProperties: false});

export const profileGeoConfigSchema = Type.Object({
    weatherBackend: geoConfigSchema.properties.weatherBackend,
    bridgeBaseUrl: geoConfigSchema.properties.bridgeBaseUrl,
    bridgeTokenFile: geoConfigSchema.properties.bridgeTokenFile,
    apiHost: Type.Optional(geoConfigSchema.properties.apiHost),
    apiKey: Type.Optional(geoConfigSchema.properties.apiKey),
    locationCatalog: Type.Optional(Type.Array(profileCatalogEntrySchema, {minItems: 1, maxItems: 512})),
}, {additionalProperties: false});
