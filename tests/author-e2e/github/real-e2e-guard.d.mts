export interface DedicatedTestRepository {
  readonly id: number;
  readonly fullName: string;
}

export type RepositoryGuardResult =
  | { ok: true; repo: { id: number; fullName: string } }
  | { ok: false; reason: string };

export const DEDICATED_TEST_REPOSITORY: DedicatedTestRepository;

export function assertDedicatedTestRepository(session: unknown): RepositoryGuardResult;
