import { DomainError } from '../../domain/errors/DomainError';
import { InsuranceClaim } from '../../domain/entities/InsuranceClaim';
import { ClaimRepository } from '../../domain/interfaces/ClaimRepository';
import { InsuranceRepository } from '../../domain/interfaces/InsuranceRepository';
import { InsuranceGatePolicy } from '../../domain/services/InsuranceGatePolicy';
import { Actor } from '../auth/Actor';
import { AuthorizationGuard } from '../auth/AuthorizationGuard';
import { AuditLog } from '../audit/AuditLog';

/**
 * Application service for admin operations on insurance claims.
 *
 * Provides lawful lifecycle operations: file, review, approve, deny, pay out.
 * All operations respect domain invariants — no overrides, no bypasses.
 *
 * Does NOT allow:
 * - Reversing terminal claim states (DENIED, PAID_OUT)
 * - Approving payout amounts exceeding claim amount
 * - Filing claims against inactive policies
 * - Skipping the review step
 */
export class AdminClaimService {
  private readonly claimRepo: ClaimRepository;
  private readonly insuranceRepo: InsuranceRepository;
  private readonly auditLog: AuditLog;

  constructor(deps: {
    claimRepo: ClaimRepository;
    insuranceRepo: InsuranceRepository;
    auditLog: AuditLog;
  }) {
    this.claimRepo = deps.claimRepo;
    this.insuranceRepo = deps.insuranceRepo;
    this.auditLog = deps.auditLog;
  }

  /**
   * File a new insurance claim. Validates against the policy via InsuranceGatePolicy.
   * Restricted to admin or system actors.
   */
  async fileClaim(
    actor: Actor,
    params: {
      id: string;
      policyId: string;
      rentalId: string;
      watchId: string;
      claimAmount: number;
      reason: string;
      filedAt: Date;
    },
  ): Promise<InsuranceClaim> {
    AuthorizationGuard.requireSystemOrAdmin(actor);

    // Validate against policy
    const policy = await this.insuranceRepo.findByWatchId(params.watchId);
    if (!policy) {
      throw new DomainError(
        'No insurance policy found for this watch',
        'INSURANCE_INACTIVE',
      );
    }

    InsuranceGatePolicy.assertCanFileClaim(
      policy,
      params.claimAmount,
      params.filedAt,
    );

    const claim = InsuranceClaim.create(params);
    await this.claimRepo.save(claim);

    this.auditLog.record({
      actor,
      entityType: 'InsuranceClaim',
      entityId: claim.id,
      action: 'file_claim',
      outcome: 'success',
      afterState: claim.status,
      correlationId: params.rentalId,
    });

    return claim;
  }

  /**
   * Begin review of a filed claim. FILED → UNDER_REVIEW.
   * Restricted to admin actors.
   */
  async beginReview(
    actor: Actor,
    claimId: string,
  ): Promise<InsuranceClaim> {
    const adminActor = AuthorizationGuard.requireAdmin(actor);

    const claim = await this.findClaimById(claimId);
    const beforeStatus = claim.status;

    claim.beginReview(adminActor.userId);
    await this.claimRepo.save(claim);

    this.auditLog.record({
      actor,
      entityType: 'InsuranceClaim',
      entityId: claimId,
      action: 'begin_claim_review',
      outcome: 'success',
      beforeState: beforeStatus,
      afterState: claim.status,
    });

    return claim;
  }

  /**
   * Approve a claim under review. UNDER_REVIEW → APPROVED.
   * Payout amount must not exceed claim amount (enforced by entity).
   * Restricted to admin actors.
   */
  async approveClaim(
    actor: Actor,
    claimId: string,
    payoutAmount: number,
    approvedAt: Date,
  ): Promise<InsuranceClaim> {
    AuthorizationGuard.requireAdmin(actor);

    const claim = await this.findClaimById(claimId);
    const beforeStatus = claim.status;

    claim.approve(approvedAt, payoutAmount);
    await this.claimRepo.save(claim);

    this.auditLog.record({
      actor,
      entityType: 'InsuranceClaim',
      entityId: claimId,
      action: 'approve_claim',
      outcome: 'success',
      beforeState: beforeStatus,
      afterState: claim.status,
    });

    return claim;
  }

  /**
   * Deny a claim under review. UNDER_REVIEW → DENIED (terminal).
   * Requires a denial reason (enforced by entity).
   * Restricted to admin actors.
   */
  async denyClaim(
    actor: Actor,
    claimId: string,
    denialReason: string,
    deniedAt: Date,
  ): Promise<InsuranceClaim> {
    AuthorizationGuard.requireAdmin(actor);

    const claim = await this.findClaimById(claimId);
    const beforeStatus = claim.status;

    claim.deny(deniedAt, denialReason);
    await this.claimRepo.save(claim);

    this.auditLog.record({
      actor,
      entityType: 'InsuranceClaim',
      entityId: claimId,
      action: 'deny_claim',
      outcome: 'success',
      beforeState: beforeStatus,
      afterState: claim.status,
    });

    return claim;
  }

  /**
   * Record payout completion. APPROVED → PAID_OUT (terminal).
   * Restricted to admin or system actors.
   */
  async markPaidOut(
    actor: Actor,
    claimId: string,
    paidOutAt: Date,
  ): Promise<InsuranceClaim> {
    AuthorizationGuard.requireSystemOrAdmin(actor);

    const claim = await this.findClaimById(claimId);
    const beforeStatus = claim.status;

    claim.markPaidOut(paidOutAt);
    await this.claimRepo.save(claim);

    this.auditLog.record({
      actor,
      entityType: 'InsuranceClaim',
      entityId: claimId,
      action: 'mark_claim_paid_out',
      outcome: 'success',
      beforeState: beforeStatus,
      afterState: claim.status,
    });

    return claim;
  }

  // --- Query methods ---

  /**
   * Look up a claim by ID.
   */
  async getClaim(actor: Actor, claimId: string): Promise<InsuranceClaim> {
    AuthorizationGuard.requireAdmin(actor);
    return this.findClaimById(claimId);
  }

  /**
   * List all claims for a rental.
   */
  async listClaimsByRental(actor: Actor, rentalId: string): Promise<InsuranceClaim[]> {
    AuthorizationGuard.requireAdmin(actor);
    return this.claimRepo.findByRentalId(rentalId);
  }

  /**
   * List all claims for a watch.
   */
  async listClaimsByWatch(actor: Actor, watchId: string): Promise<InsuranceClaim[]> {
    AuthorizationGuard.requireAdmin(actor);
    return this.claimRepo.findByWatchId(watchId);
  }

  /**
   * List open claims for a watch (claims actively blocking operations).
   */
  async listOpenClaimsByWatch(actor: Actor, watchId: string): Promise<InsuranceClaim[]> {
    AuthorizationGuard.requireAdmin(actor);
    return this.claimRepo.findOpenByWatchId(watchId);
  }

  // --- Private helpers ---

  private async findClaimById(claimId: string): Promise<InsuranceClaim> {
    const claim = await this.claimRepo.findById(claimId);
    if (!claim) {
      throw new DomainError(
        `Insurance claim ${claimId} not found`,
        'INSURANCE_POLICY_INVALID',
      );
    }
    return claim;
  }
}
