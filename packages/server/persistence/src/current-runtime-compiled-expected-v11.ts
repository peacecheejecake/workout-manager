// Compiled from two independent named-profile27 owner observations (2026-10-13), each on
// a freshly provisioned PG 17.6 cluster: two fresh V11 installs and one committed profile26
// upgraded to V11 agreed on every section, catalogSha256 and sqlJsonbSha256. Every database
// carried the same recipe: app baseline v2 core, grants V11 for the runtime role, and the two
// fixed principals (workout_gallery_rendition_worker: 5 worker RPCs; workout_ai_dispatcher:
// disposition SELECT/INSERT), both always present as LOGIN roles with no elevated attribute,
// no rolconfig and no membership. A deployment without either principal, or with different
// attributes, is a catalog mismatch by construction. The same runs' committed profile26
// reproduced the pinned profile26 digest with the V10 path (control).
// This immutable build input authenticates neither processing nor owner receipts.
// Runtime observation and dynamic/caller closure are separate acceptance gates.
const compiled = {
  assetVersion: 1,
  metadataEncoding: 'pg-catalog-runtime-security-normalized-v3-principals-v11',
  recognizedNamespaces: [
    'garmin_private',
    'identity_private',
    'public',
    'wm_app_load',
    'wm_check_in_templates_v1',
    'wm_manual_pooled',
    'wm_runtime_installation',
  ],
  principalRoleTags: ['ai_dispatcher', 'gallery_rendition_worker'],
  profileVersion: 11,
  runtimeStep: 27,
  sourceDdlTip: 148,
  catalogSha256: '40c62f7e186124b34661469328bbfc8c1d8028189cc1ff2ca8215f1769861a43',
  sqlJsonbSha256: 'add5bf297a0dcfba5c1a17911cff9349c4db382cca8a94eb479f05158a4259a5',
  sections: [
    {
      section: 'schemas',
      rowCount: 7,
      bytes: 2029,
      sha256: 'e61c649115980d3f54d4c263806f18ac323b36860a0772b1a83fa5003752988a',
    },
    {
      section: 'functions',
      rowCount: 731,
      bytes: 417304,
      sha256: '5159eb264a3ee48d0fc3fe30f4c266814db7590b599ac2cf5bbfd2d9c69f74c5',
    },
    {
      section: 'relations',
      rowCount: 756,
      bytes: 2335973,
      sha256: '3f092d69f5d0c91326d57d2ab4fe1776f51c8fc80244dd94a58be9b6c1e40eac',
    },
    {
      section: 'defaultPrivileges',
      rowCount: 0,
      bytes: 2,
      sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    },
    {
      section: 'roles',
      rowCount: 10,
      bytes: 1766,
      sha256: 'bd7d7bf4836925e9cb700d6ae3e3455be48f1c73f26935a382ee61f1e1499a83',
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
      rowCount: 508,
      bytes: 111191,
      sha256: '715c2f005053884bf552a0aacf0258be875b8cc710f4ff09ad74fd399115686a',
    },
    {
      section: 'collations',
      rowCount: 2,
      bytes: 307,
      sha256: '29438615bce9043e119178c36eee8ad28e1b2db48c89d418e074843b64c43b83',
    },
    {
      section: 'dependencies',
      rowCount: 9960,
      bytes: 2241335,
      sha256: '894f774b31d1e3df89671a105f848559afe1fdd710a33584fbebf736b0693ab0',
    },
    {
      section: 'typeDetails',
      rowCount: 508,
      bytes: 664181,
      sha256: '3333aff10521d59b77d6084ba6dc88ba29ad876ab9faace6b03b30aaa0b603fd',
    },
    {
      section: 'functionDetails',
      rowCount: 731,
      bytes: 235323,
      sha256: 'faed7002a13e721a5c0af15030ff2d9eb6c6cde571b6258148867f0f5285dfe0',
    },
    {
      section: 'relationDetails',
      rowCount: 756,
      bytes: 353415,
      sha256: '4ca7acd0a018efd5f4ca27e2e9cde373390dae5eb8f905fecd9db025a7962f55',
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
      rowCount: 512,
      bytes: 60243,
      sha256: '97234b3d74fb349326ebcba3dfaecd928c7ad52d6fb5499aa5ba00387b654b2d',
    },
    {
      section: 'sharedDependencies',
      rowCount: 1451,
      bytes: 150681,
      sha256: '21fdd382372ba1ae6dd16f14757fdb0ae5277042a11d2d3b705a5b2a7ec9a937',
    },
  ],
  provenance: {
    sourceManifestSha256: '9e914eef187416c0d4724e0bd87e26be7da3745f23ae6a2e1dfcc8897cd0764b',
    recipeSha256: '47205e21fdde011b74cfc72ccaf9ab096c329babe1536daa9151544cecab471c',
    captureScriptSha256: '6db87a92c767fe044c78907ea53a391f22a324eeb0bec6834d5c905decc206f2',
    manifestGeneratorSha256: '899b3706dd2c202bcf09422366da81cba8f9bc8f01afbe8de5aa591e21d1c807',
    artifactSha256: '7c7069d98a67f555230726852da3c018b4519828f947758a9964acf30e832266',
    profile26ControlArtifactSha256:
      '4bf5cf049174597a1d7c639cdfd12a739e49731b25b0f7f8d6810a97998a0b13',
    profile26ControlCatalogSha256:
      'eb61b2d63191eb10e802fbf155a7e1b48f550c6b66bca93d5372d2992f62ee17',
    ownerObservations: 2,
    databasesPerObservation: { fresh: 2, upgradedFromProfile26: 1 },
    runtimeObservation: 'not_executed',
    dynamicClosure: 'not_verified',
    strictCallerWireClosure: 'not_verified',
  },
} as const;
export const currentRuntimeCompiledExpectedV11 = Object.freeze({
  ...compiled,
  recognizedNamespaces: Object.freeze([...compiled.recognizedNamespaces]),
  principalRoleTags: Object.freeze([...compiled.principalRoleTags]),
  sections: Object.freeze(compiled.sections.map((section) => Object.freeze(section))),
  provenance: Object.freeze({
    ...compiled.provenance,
    databasesPerObservation: Object.freeze({ ...compiled.provenance.databasesPerObservation }),
  }),
});
