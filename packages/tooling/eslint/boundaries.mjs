import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

const serverDependencies =
  /^(?:fastify|@fastify\/|pg$|postgres$|@prisma\/|prisma$|drizzle-orm(?:\/|$)|server-only$)/;
const frameworkDependencies =
  /^(?:react(?:-dom)?(?:\/|$)|next(?:\/|$)|fastify(?:\/|$)|@fastify\/|pg$|postgres$|@prisma\/|prisma$|drizzle-orm(?:\/|$))/;
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
/**
 * Map plan §5: `experience/geo-kit` takes an SDK-free MapPath, a selected position and
 * events, and only its MapLibre adapter module owns SDK objects. So the map SDK may be
 * imported by that one module (and by the M0 UI spike's one map panel, which predates the
 * kit), never by the kit's SDK-free files, a domain module or an app shell. The kit's own
 * tests may name SDK *types* only. Nobody re-exports the SDK: that would hand its objects
 * past the adapter under another name.
 */
const mapSdk = /^maplibre-gl(?:\/|$)/;
/** The SDK reached by a path into the installed package instead of by its name. */
const mapSdkPath = /\/node_modules\/maplibre-gl(?:\/|$)/;
const mapSdkOwners = [
  /^packages\/experience\/geo-kit\/src\/maplibre-adapter\.tsx?$/,
  /^packages\/experience\/ui-spike\/src\/map-panel\.tsx$/,
];
const mapSdkTypeReaders = [/^packages\/experience\/geo-kit\/tests\//];
/** Source-file parsers (FIT/GPX); an experience kit receives display paths, not files. */
const trackParsing = 'packages/track-parsing';

function inside(directory, filename) {
  const relative = path.relative(directory, filename);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function layer(root, directory) {
  const relative = path.relative(root, directory).split(path.sep).join('/');
  if (relative.startsWith('apps/')) return 'app';
  if (relative.startsWith('packages/modules/')) return 'module';
  if (/^packages\/(ui|experience|kits)(?:\/|$)/.test(relative)) return 'ui';
  if (/^packages\/server\/domain(?:\/|$)/.test(relative)) return 'domain';
  if (relative.startsWith('packages/server/')) return 'server';
  if (/^packages\/shared(?:\/|$)/.test(relative)) return 'pure-shared';
  if (/^packages\/(contracts|api-client|platform)(?:\/|$)/.test(relative)) return 'shared';
  return 'tooling';
}

/** Read real workspace manifests, so new package names do not need a second registry. */
function workspacePackages(root) {
  const packages = [];
  function visit(directory) {
    if (!existsSync(directory)) return;
    const manifestPath = path.join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      packages.push({
        directory,
        name: manifest.name,
        exports: manifest.exports,
        layer: layer(root, directory),
      });
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        visit(path.join(directory, entry.name));
      }
    }
  }
  visit(path.join(root, 'apps'));
  visit(path.join(root, 'packages'));
  return packages;
}

function hasTarget(value) {
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(hasTarget);
}

function exported(exports, subpath) {
  if (typeof exports === 'string' || Array.isArray(exports))
    return subpath === '.' && hasTarget(exports);
  if (!exports || typeof exports !== 'object') return false;
  const keys = Object.keys(exports);
  if (!keys.some((key) => key.startsWith('.'))) return subpath === '.' && hasTarget(exports);
  if (Object.hasOwn(exports, subpath)) return hasTarget(exports[subpath]);
  // Most-specific pattern wins, including explicit null exclusions.
  const matching = keys
    .filter((key) => {
      const [prefix, suffix] = key.split('*');
      return suffix !== undefined && subpath.startsWith(prefix) && subpath.endsWith(suffix);
    })
    .sort((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length);
  return matching.length > 0 && hasTarget(exports[matching[0]]);
}

/** Enforce package exports and the architecture's dependency direction on all import forms. */
export function createBoundaryRule(root) {
  const packages = workspacePackages(root);
  return {
    meta: {
      type: 'problem',
      schema: [],
      messages: {
        boundary: '{{reason}} ({{source}})',
        computed: 'Use a literal module specifier so package boundaries can be verified.',
      },
    },
    create(context) {
      const filename = context.filename;
      const owner = packages.find((item) => inside(item.directory, filename));
      const sourceLayer = owner?.layer ?? layer(root, path.dirname(filename));
      const clientDirective = context.sourceCode.ast.body.some(
        (node) => node.type === 'ExpressionStatement' && node.directive === 'use client',
      );
      const relativeFile = path.relative(root, filename).split(path.sep).join('/');
      const browser =
        ['module', 'ui', 'shared', 'pure-shared'].includes(sourceLayer) ||
        clientDirective ||
        /^apps\/(mobile-web|mobile)\//.test(relativeFile);

      /** `kind`: how the module is used — a value import, a type-only import, or a re-export. */
      function check(node, kind = 'value') {
        if (!node) return;
        const source =
          node.type === 'TemplateLiteral' && node.expressions.length === 0
            ? node.quasis[0].value.cooked
            : node.value;
        if (typeof source !== 'string') {
          context.report({ node, messageId: 'computed' });
          return;
        }
        let target;
        let reason;
        let sdk = mapSdk.test(source);
        if (source.startsWith('.') || path.isAbsolute(source)) {
          const resolved = path.resolve(path.dirname(filename), source);
          if (mapSdkPath.test(resolved.split(path.sep).join('/'))) sdk = true;
          target = packages.find((item) => inside(item.directory, resolved));
          if (target && target !== owner && sourceLayer !== 'tooling')
            reason = 'Cross-package paths must use a public package export';
        } else {
          target = packages.find(
            (item) => item.name && (source === item.name || source.startsWith(`${item.name}/`)),
          );
          if (
            target &&
            !exported(
              target.exports,
              source === target.name ? '.' : `.${source.slice(target.name.length)}`,
            )
          ) {
            reason = 'Import only declared public package exports';
          }
        }
        if (sourceLayer !== 'app' && sourceLayer !== 'tooling' && /^next(?:\/|$)/.test(source)) {
          reason = 'Next.js APIs belong in the web shell';
        }
        if (
          browser &&
          (serverDependencies.test(source) || ['server', 'domain'].includes(target?.layer))
        ) {
          reason = 'Browser packages cannot import server implementation';
        }
        if (browser && (source.startsWith('node:') || builtins.has(source))) {
          reason = 'Browser packages cannot import Node.js built-ins';
        }
        if (sourceLayer === 'ui' && ['module', 'app'].includes(target?.layer)) {
          reason = 'UI and experience kits cannot depend on modules or apps';
        }
        if (
          sourceLayer === 'ui' &&
          target &&
          path.relative(root, target.directory).split(path.sep).join('/') === trackParsing
        ) {
          reason = 'Experience kits receive display paths, never FIT/GPX parsers';
        }
        if (sdk) {
          if (kind === 'export') reason = 'The map SDK is never re-exported';
          else if (
            !mapSdkOwners.some((owner) => owner.test(relativeFile)) &&
            !(kind === 'type' && mapSdkTypeReaders.some((reader) => reader.test(relativeFile)))
          )
            reason = 'Only the geo-kit MapLibre adapter may import the map SDK';
        }
        if (sourceLayer === 'shared' && ['module', 'ui', 'app'].includes(target?.layer)) {
          reason = 'Shared contracts and platform cannot depend on UI, modules, or apps';
        }
        if (
          sourceLayer === 'pure-shared' &&
          (frameworkDependencies.test(source) || (target && target.layer !== 'pure-shared'))
        ) {
          reason = 'Pure shared utilities cannot depend on frameworks or outer layers';
        }
        if (sourceLayer === 'module' && target?.layer === 'app')
          reason = 'Modules cannot depend on application shells';
        if (sourceLayer === 'server' && ['module', 'ui', 'app'].includes(target?.layer))
          reason = 'Server packages cannot depend on UI or application shells';
        if (
          sourceLayer === 'domain' &&
          (frameworkDependencies.test(source) ||
            source.startsWith('node:') ||
            builtins.has(source) ||
            (target &&
              target.layer !== 'domain' &&
              target.layer !== 'pure-shared' &&
              path.relative(root, target.directory).split(path.sep).join('/') !==
                'packages/contracts'))
        ) {
          reason = 'Pure domain code cannot depend on frameworks, I/O, or outer layers';
        }
        if (reason) context.report({ node, messageId: 'boundary', data: { reason, source } });
      }
      return {
        ImportDeclaration: (node) =>
          check(node.source, node.importKind === 'type' ? 'type' : 'value'),
        ExportNamedDeclaration: (node) => check(node.source, 'export'),
        ExportAllDeclaration: (node) => check(node.source, 'export'),
        ImportExpression: (node) => check(node.source),
        TSImportType: (node) => check(node.source, 'type'),
        TSExternalModuleReference: (node) => check(node.expression),
        CallExpression(node) {
          if (node.callee.type === 'Identifier' && node.callee.name === 'require')
            check(node.arguments[0]);
        },
      };
    },
  };
}
