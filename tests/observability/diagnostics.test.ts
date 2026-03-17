import { describe, it, expect, beforeEach } from 'vitest';
import { SystemDiagnosticsService } from '../../src/observability/diagnostics/SystemDiagnosticsService';
import { IncidentSnapshotBuilder } from '../../src/observability/diagnostics/IncidentSnapshotBuilder';
import { CircuitBreaker } from '../../src/infrastructure/resilience/CircuitBreaker';
import { HealthMonitor } from '../../src/infrastructure/resilience/HealthMonitor';
import { loadResilienceConfig } from '../../src/infrastructure/resilience/ResilienceConfig';
import { MetricsRegistry } from '../../src/observability/metrics/MetricsRegistry';
import { InMemoryOutboxRepository } from '../../src/infrastructure/repositories/InMemoryOutboxRepository';
import { InMemoryReconciliationRepository } from '../../src/infrastructure/repositories/InMemoryReconciliationRepository';
import { AuditLog } from '../../src/application/audit/AuditLog';
import { InMemoryAuditSink } from '../../src/infrastructure/audit/InMemoryAuditSink';
import { OutboxEvent } from '../../src/domain/entities/OutboxEvent';

describe('SystemDiagnosticsService', () => {
  let breaker: CircuitBreaker;
  let healthMonitor: HealthMonitor;
  let outboxRepo: InMemoryOutboxRepository;
  let reconRepo: InMemoryReconciliationRepository;
  let diagnosticsService: SystemDiagnosticsService;

  beforeEach(() => {
    MetricsRegistry.resetForTesting();
    const config = loadResilienceConfig();
    breaker = new CircuitBreaker({
      name: 'test-breaker',
      failureThreshold: 3,
      resetTimeoutMs: 5000,
      halfOpenMaxProbes: 1,
    });
    healthMonitor = new HealthMonitor(config, [breaker]);
    outboxRepo = new InMemoryOutboxRepository();
    reconRepo = new InMemoryReconciliationRepository();

    const dataSources = {
      getOutboxDiagnostics: () => outboxRepo.diagnostics(),
      getReconciliationDiagnostics: () => reconRepo.diagnostics(),
    };

    diagnosticsService = new SystemDiagnosticsService(
      [breaker], healthMonitor, dataSources, MetricsRegistry.getInstance(),
    );
  });

  it('getSystemSnapshot returns complete snapshot', async () => {
    healthMonitor.recordWorkerHeartbeat('outbox-worker', true);
    const snapshot = await diagnosticsService.getSystemSnapshot();

    expect(snapshot.timestamp).toBeDefined();
    expect(snapshot.breakers).toHaveLength(1);
    expect(snapshot.breakers[0].name).toBe('test-breaker');
    expect(snapshot.outbox).toBeDefined();
    expect(snapshot.outbox.pending).toBe(0);
    expect(snapshot.reconciliation).toBeDefined();
    expect(typeof snapshot.metricsCount).toBe('number');
  });

  it('getOutboxDiagnostics returns backlog and dead letter counts', async () => {
    const event = OutboxEvent.create({
      id: 'evt-diag-1',
      topic: 'payment.capture',
      aggregateType: 'Rental',
      aggregateId: 'r-1',
      payload: {},
      dedupKey: 'test-1',
    });
    await outboxRepo.create(event);

    const diag = await diagnosticsService.getOutboxDiagnostics();
    expect(diag.backlogSize).toBe(1);
    expect(diag.deadLetterCount).toBe(0);
  });

  it('getReconciliationDiagnostics returns correct structure', async () => {
    const diag = await diagnosticsService.getReconciliationDiagnostics();
    expect(diag.unresolvedCriticalCount).toBe(0);
    expect(diag.lastSuccessfulRun).toBeNull();
    expect(diag.repairSuccessCount).toBe(0);
  });
});

describe('IncidentSnapshotBuilder', () => {
  let outboxRepo: InMemoryOutboxRepository;
  let reconRepo: InMemoryReconciliationRepository;
  let auditLog: AuditLog;
  let builder: IncidentSnapshotBuilder;

  beforeEach(() => {
    outboxRepo = new InMemoryOutboxRepository();
    reconRepo = new InMemoryReconciliationRepository();
    auditLog = new AuditLog(new InMemoryAuditSink());
    builder = new IncidentSnapshotBuilder(outboxRepo, reconRepo, auditLog);
  });

  it('builds snapshot for rental with no data', async () => {
    const snapshot = await builder.buildForRental('rental-nonexistent');

    expect(snapshot.rentalId).toBe('rental-nonexistent');
    expect(snapshot.generatedAt).toBeDefined();
    expect(snapshot.auditEntries).toHaveLength(0);
    expect(snapshot.outboxEvents).toHaveLength(0);
    expect(snapshot.reconciliationFindings).toHaveLength(0);
  });

  it('includes audit entries for the rental', async () => {
    auditLog.record({
      actor: { kind: 'system', source: 'test' },
      entityType: 'Rental',
      entityId: 'rental-1',
      action: 'initiate_rental',
      outcome: 'success',
      afterState: 'PENDING_PAYMENT',
    });
    auditLog.record({
      actor: { kind: 'system', source: 'test' },
      entityType: 'Rental',
      entityId: 'rental-other',
      action: 'other',
      outcome: 'success',
    });

    const snapshot = await builder.buildForRental('rental-1');
    expect(snapshot.auditEntries).toHaveLength(1);
    expect(snapshot.auditEntries[0].action).toBe('initiate_rental');
    expect(snapshot.auditEntries[0].outcome).toBe('success');
  });

  it('includes outbox events for the rental', async () => {
    const event = OutboxEvent.create({
      id: 'evt-incident-1',
      topic: 'payment.capture',
      aggregateType: 'Rental',
      aggregateId: 'rental-1',
      payload: { rentalId: 'rental-1' },
      dedupKey: 'capture:rental-1',
    });
    await outboxRepo.create(event);

    const snapshot = await builder.buildForRental('rental-1');
    expect(snapshot.outboxEvents).toHaveLength(1);
    expect(snapshot.outboxEvents[0].topic).toBe('payment.capture');
    expect(snapshot.outboxEvents[0].status).toBe('PENDING');
  });

  it('gathers data in parallel', async () => {
    // Just verify it doesn't throw and returns correct structure
    const event = OutboxEvent.create({
      id: 'evt-incident-2',
      topic: 'payment.refund',
      aggregateType: 'Rental',
      aggregateId: 'rental-2',
      payload: {},
      dedupKey: 'refund:rental-2',
    });
    await outboxRepo.create(event);

    auditLog.record({
      actor: { kind: 'system', source: 'test' },
      entityType: 'Rental',
      entityId: 'rental-2',
      action: 'refund',
      outcome: 'success',
    });

    const snapshot = await builder.buildForRental('rental-2');
    expect(snapshot.outboxEvents).toHaveLength(1);
    expect(snapshot.auditEntries).toHaveLength(1);
    expect(snapshot.reconciliationFindings).toHaveLength(0);
  });
});
