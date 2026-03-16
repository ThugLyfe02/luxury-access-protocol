import { DomainError } from '../errors/DomainError';
import { CustodyEventType } from '../enums/CustodyEventType';

export class CustodyEvent {
  readonly id: string;
  readonly rentalId: string;
  readonly eventType: CustodyEventType;
  readonly actorId: string;
  readonly notes: string;
  readonly occurredAt: Date;

  constructor(params: {
    id: string;
    rentalId: string;
    eventType: CustodyEventType;
    actorId: string;
    notes: string;
    occurredAt: Date;
  }) {
    if (!params.id) {
      throw new DomainError(
        'Custody event ID is required',
        'CUSTODY_EVIDENCE_REQUIRED',
      );
    }

    if (!params.rentalId) {
      throw new DomainError(
        'Rental ID is required for custody event',
        'CUSTODY_EVIDENCE_REQUIRED',
      );
    }

    if (!params.actorId) {
      throw new DomainError(
        'Actor ID is required for custody event',
        'CUSTODY_EVIDENCE_REQUIRED',
      );
    }

    this.id = params.id;
    this.rentalId = params.rentalId;
    this.eventType = params.eventType;
    this.actorId = params.actorId;
    this.notes = params.notes;
    this.occurredAt = params.occurredAt;
  }
}
