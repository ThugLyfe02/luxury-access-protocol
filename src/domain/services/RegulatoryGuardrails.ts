import { DomainError } from '../errors/DomainError';

const FORBIDDEN_CUSTODY_KEYWORDS: readonly string[] = [
  'principal',
  'escrow',
  'wallet',
  'balance',
  'transferfunds',
  'credituser',
  'debituser',
  'heldfunds',
  'userfunds',
  'internaltransfer',
  'platformbalance',
  'payoutqueue',
  'releaseatdiscretion',
];

export class RegulatoryGuardrails {
  static assertNoCustodyPrincipalMutation(
    operation: string,
    context?: Record<string, unknown>,
  ): void {
    const operationLower = operation.toLowerCase();

    for (const keyword of FORBIDDEN_CUSTODY_KEYWORDS) {
      if (operationLower.includes(keyword)) {
        throw new DomainError(
          'Custody violation detected',
          'CUSTODY_VIOLATION',
        );
      }
    }

    if (context) {
      let serialized: string;
      try {
        serialized = JSON.stringify(context).toLowerCase();
      } catch {
        serialized = String(Object.keys(context)).toLowerCase();
      }
      for (const keyword of FORBIDDEN_CUSTODY_KEYWORDS) {
        if (serialized.includes(keyword)) {
          throw new DomainError(
            'Custody violation detected',
            'CUSTODY_VIOLATION',
          );
        }
      }
    }
  }
}
