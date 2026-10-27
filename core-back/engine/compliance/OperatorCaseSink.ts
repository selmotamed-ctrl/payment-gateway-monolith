import type { PrismaLike } from "../db/ports";
import type { OperatorCaseOpenInput, OperatorCaseSink } from "../flow/DynamicRailEngine";

const OPEN_STATES = ["OPEN", "IN_PROGRESS", "PENDING_CHECKER"];

export class PrismaOperatorCaseSink implements OperatorCaseSink {
  private readonly client: PrismaLike;

  constructor(client: PrismaLike) {
    this.client = client;
  }

  async open(input: OperatorCaseOpenInput): Promise<{ id: string; created: boolean }> {
    const existing = await this.client.operatorCase.findFirst({
      where: {
        attemptId: input.attemptId,
        kind: input.kind,
        state: { in: OPEN_STATES },
      },
      select: { id: true },
    });
    if (existing) {
      return { id: String(existing.id), created: false };
    }
    const notes = `${input.title}: ${input.detail}`.slice(0, 1000);
    const created = await this.client.operatorCase.create({
      data: {
        attemptId: input.attemptId,
        kind: input.kind,
        priority: input.priority,
        state: "OPEN",
        slaDueAt: input.slaDueAt,
        resolutionNotes: notes,
      },
    });
    return { id: String(created.id), created: true };
  }
}
