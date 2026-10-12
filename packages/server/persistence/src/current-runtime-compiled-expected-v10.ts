// Compiled from two independent named-profile26 owner observations (2026-10-12), each on
// a freshly provisioned PG 17.6 cluster: two fresh V10 installs and one committed profile25
// upgraded to V10 agreed on every section, catalogSha256 and sqlJsonbSha256. The same runs'
// committed profile25 reproduced the pinned profile25 digest with the V9 path (control).
// This immutable build input authenticates neither processing nor owner receipts.
// Runtime observation and dynamic/caller closure are separate acceptance gates.
const compiled = {
  assetVersion: 1,
  metadataEncoding: 'pg-catalog-runtime-security-normalized-v3',
  recognizedNamespaces: [
    'garmin_private',
    'identity_private',
    'public',
    'wm_app_load',
    'wm_check_in_templates_v1',
    'wm_manual_pooled',
    'wm_runtime_installation',
  ],
  profileVersion: 10,
  runtimeStep: 26,
  sourceDdlTip: 146,
  catalogSha256: 'eb61b2d63191eb10e802fbf155a7e1b48f550c6b66bca93d5372d2992f62ee17',
  sqlJsonbSha256: '15de83920213bf1b8292a87b9959ce6b5d880e7600a0e8bab05b812e723f591d',
  sections: [
    {
      section: 'schemas',
      rowCount: 7,
      bytes: 2029,
      sha256: 'e61c649115980d3f54d4c263806f18ac323b36860a0772b1a83fa5003752988a',
    },
    {
      section: 'functions',
      rowCount: 665,
      bytes: 379586,
      sha256: '59e68ebe015bf5a697a8a636c05f7f19f201566127bc2d456cba61f25e87df0a',
    },
    {
      section: 'relations',
      rowCount: 708,
      bytes: 2173246,
      sha256: 'fe2630064e4a499069a73952ccafe161fc33b6e726646af33043efba9e5a4c0c',
    },
    {
      section: 'defaultPrivileges',
      rowCount: 0,
      bytes: 2,
      sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    },
    {
      section: 'roles',
      rowCount: 8,
      bytes: 1413,
      sha256: '6daa168719c77a5370e7fdbbca23090e9c89842019b26f6d61e001812e26b1e4',
    },
    {
      section: 'memberships',
      rowCount: 3,
      bytes: 405,
      sha256: 'e4c2a4f72394ede52fabe5c72e1d3ad9437833f0616586d6d3f5556d2ae844de',
    },
    {
      section: 'extensions',
      rowCount: 1,
      bytes: 225,
      sha256: '493bdb91a6b35036c4b24bbe143b43c91b21d3f2446398b438e29e098a667644',
    },
    {
      section: 'types',
      rowCount: 480,
      bytes: 104901,
      sha256: 'e26eaa351177654b5b018c15511514ef5f5baf82e63901609a476ca403890e6a',
    },
    {
      section: 'collations',
      rowCount: 2,
      bytes: 307,
      sha256: '29438615bce9043e119178c36eee8ad28e1b2db48c89d418e074843b64c43b83',
    },
    {
      section: 'dependencies',
      rowCount: 9207,
      bytes: 2080712,
      sha256: '1f9d6623326d7129b75cd269b8aeb82a2bd69d10da86baf4d3be457fa9db9233',
    },
    {
      section: 'typeDetails',
      rowCount: 480,
      bytes: 623686,
      sha256: '231e3541e06f03277816e55d7a91b453a66affe53caa1edb0b01058531477f96',
    },
    {
      section: 'functionDetails',
      rowCount: 665,
      bytes: 214346,
      sha256: 'cf9cd522aa09aff992c720d594c56d546a7af40bc0e20356c2b02d8ba9154820',
    },
    {
      section: 'relationDetails',
      rowCount: 708,
      bytes: 329980,
      sha256: '9c2e80e70d21ae3b978e05ae910f60d55cef2e38cf117d28d56621ba16ece34e',
    },
    {
      section: 'operators',
      rowCount: 0,
      bytes: 2,
      sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    },
    {
      section: 'casts',
      rowCount: 0,
      bytes: 2,
      sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    },
    {
      section: 'languages',
      rowCount: 4,
      bytes: 1441,
      sha256: '90fe4847b346af79f4cde9213ab17ca2a31e0b57e99749ac2064aa6649a177c1',
    },
    {
      section: 'accessMethods',
      rowCount: 7,
      bytes: 435,
      sha256: 'b34ee9d8263b37b8c441370559c07a49c91bc7893071019a9737712f4a83824c',
    },
    {
      section: 'eventTriggers',
      rowCount: 0,
      bytes: 2,
      sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    },
    {
      section: 'foreignWrappers',
      rowCount: 0,
      bytes: 2,
      sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    },
    {
      section: 'foreignServers',
      rowCount: 0,
      bytes: 2,
      sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    },
    {
      section: 'foreignTables',
      rowCount: 0,
      bytes: 2,
      sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    },
    {
      section: 'userMappings',
      rowCount: 0,
      bytes: 2,
      sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    },
    {
      section: 'operatorClasses',
      rowCount: 0,
      bytes: 2,
      sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    },
    {
      section: 'operatorFamilies',
      rowCount: 0,
      bytes: 2,
      sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    },
    {
      section: 'aggregates',
      rowCount: 0,
      bytes: 2,
      sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    },
    {
      section: 'transforms',
      rowCount: 0,
      bytes: 2,
      sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    },
    {
      section: 'additionalDependencies',
      rowCount: 484,
      bytes: 56781,
      sha256: '04f8bb67911cb89c1b21f058844d572bc38357298492405ecd3901cfe5792ead',
    },
    {
      section: 'sharedDependencies',
      rowCount: 1349,
      bytes: 139858,
      sha256: 'ddd0dd568935f79d09ffc6f22da1914fa6d98ec7060128a53fb0b210b8083679',
    },
  ],
  provenance: {
    sourceManifestSha256: '9e35560c1eaed09ba8f2b45cfd0374088c6bb4bef83b7bc5e4c0f395c30cdc8b',
    recipeSha256: 'fbdd249740c74a25ca28d8e238bfb3a96f985a1259a6424a3245f9b95a97f142',
    captureScriptSha256: 'e2423c1ab1ce040f6f5fe4959d9209272cbcba38e1a3d2a9716220d1cb9b2a93',
    manifestGeneratorSha256: '0aaea8d00030269be8495188e68368886113e83ebe3352dabd9fe5ad68a6e47b',
    artifactSha256: 'f84ec9f11eecaf15180512bfd36034c7779ae543b13e5d1cbfcfc9618fda9ada',
    profile25ControlArtifactSha256:
      '8c8c5e3572343bf15173a9307cd717b61be310fa30a770ed67120cf5f821ed14',
    profile25ControlCatalogSha256:
      '127a416fb0435ed46225efc82db503d33597dcb01e006f15fb5a7ac3b4c170ed',
    ownerObservations: 2,
    databasesPerObservation: { fresh: 2, upgradedFromProfile25: 1 },
    runtimeObservation: 'not_executed',
    dynamicClosure: 'not_verified',
    strictCallerWireClosure: 'not_verified',
  },
} as const;
export const currentRuntimeCompiledExpectedV10 = Object.freeze({
  ...compiled,
  recognizedNamespaces: Object.freeze([...compiled.recognizedNamespaces]),
  sections: Object.freeze(compiled.sections.map((section) => Object.freeze(section))),
  provenance: Object.freeze({
    ...compiled.provenance,
    databasesPerObservation: Object.freeze({ ...compiled.provenance.databasesPerObservation }),
  }),
});
