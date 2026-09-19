import { notFound } from 'next/navigation';
import { privateTextResourceSchema } from '@workout/contracts/resources';
import { ResourcePage } from '../resource-page';

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ resourceId: string }>;
  searchParams: Promise<{ version?: string | string[] }>;
}) {
  const { resourceId } = await params;
  const query = await searchParams;
  const parsedResource = privateTextResourceSchema.shape.id.safeParse(resourceId);
  const parsedVersion =
    typeof query.version === 'string'
      ? privateTextResourceSchema.shape.currentVersionId.safeParse(query.version)
      : null;
  if (!parsedResource.success || (parsedVersion !== null && !parsedVersion.success)) notFound();
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/resources">자료실</a> · <a href="/coach">코치</a> · <a href="/account">계정</a>
      </nav>
      <ResourcePage
        resourceId={parsedResource.data}
        versionId={parsedVersion?.success ? parsedVersion.data : null}
      />
    </main>
  );
}
