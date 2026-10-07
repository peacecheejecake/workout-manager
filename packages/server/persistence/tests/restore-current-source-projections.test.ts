import { expect, it } from 'vitest';
import { CURRENT_PARENT_TYPED_RELATIONS } from '../src/restore-current-parent-artifact.js';
import { currentFamilyRelations } from '../src/restore-current-family-artifact.js';
import {
  currentSourceExtraRelations,
  currentSourceExtraPhysicalRoster,
} from '../src/restore-current-source-partitions.js';
import {
  currentSourceLegacyPhysicalRoster,
  currentSourcePhysicalDefinition,
  currentSourcePhysicalRelations,
  currentSourcePhysicalSql,
  CURRENT_SOURCE_PROJECTION_METADATA_SHA256,
} from '../src/restore-current-source-projections.js';
it('has exact static109 legacy relations, reuses113 extra definitions and preserves all222 membership', () => {
  expect(Object.keys(currentSourceLegacyPhysicalRoster)).toEqual([
    ...CURRENT_PARENT_TYPED_RELATIONS,
    ...currentFamilyRelations,
  ]);
  expect(currentSourcePhysicalRelations).toHaveLength(222);
  expect(new Set(currentSourcePhysicalRelations).size).toBe(222);
  for (const relation of currentSourceExtraRelations)
    expect(currentSourcePhysicalDefinition(relation)).toBe(
      currentSourceExtraPhysicalRoster[relation],
    );
});
it('pins actual metadata provenance and preserves static source column/PK shapes without caller metadata', () => {
  expect(CURRENT_SOURCE_PROJECTION_METADATA_SHA256).toMatch(/^[a-f0-9]{64}$/);
  expect(currentSourceLegacyPhysicalRoster['identity_private.account'].primaryKey).toEqual([
    'athlete_id',
  ]);
  expect(
    currentSourceLegacyPhysicalRoster.course_revision.columns.find(
      (c) => c.name === 'distance_meters',
    ),
  ).toEqual({ name: 'distance_meters', type: 'double precision', nullable: false });
  for (const definition of Object.values(currentSourceLegacyPhysicalRoster)) {
    expect(new Set(definition.columns.map((c) => c.name)).size).toBe(definition.columns.length);
    for (const key of definition.primaryKey)
      expect(definition.columns.some((c) => c.name === key)).toBe(true);
  }
});
it('uses UTC microseconds/int8 text/bytea hex and independent float binary evidence without untrusted identifiers', () => {
  expect(currentSourcePhysicalSql('manual_race_evidence_v2').row).toContain('US');
  expect(currentSourcePhysicalSql('nutrition_race_item_disconnection').row).toContain('encode(');
  const float = currentSourcePhysicalSql('course_revision');
  expect(float.row).toContain("to_jsonb('-0'::text)");
  expect(float.floatSigns).toContain('float8send(t."distance_meters")');
  expect(currentSourcePhysicalSql('resource_url_fetch_hop').layouts).toContain('array_lower');
  expect(currentSourcePhysicalSql('openai_budget_month').row).toContain('::text');
  expect(currentSourcePhysicalSql('race_collection_head').row).toContain(
    '\'privacy_generation\',t."privacy_generation"::text',
  );
  for (const name of ['public.secret;DROP TABLE', 'constructor', '__proto__'])
    expect(() => currentSourcePhysicalSql(name)).toThrow('UNKNOWN_SOURCE_RELATION');
});
