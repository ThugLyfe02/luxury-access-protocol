import { User } from '../../domain/entities/User';
import { UserRepository } from '../../domain/interfaces/UserRepository';

interface UserRecord {
  readonly id: string;
  readonly role: string;
  readonly trustScore: number;
  readonly disputesCount: number;
  readonly chargebacksCount: number;
  readonly createdAt: string;
}

function toRecord(user: User): UserRecord {
  return {
    id: user.id,
    role: user.role,
    trustScore: user.trustScore,
    disputesCount: user.disputesCount,
    chargebacksCount: user.chargebacksCount,
    createdAt: user.createdAt.toISOString(),
  };
}

function fromRecord(record: UserRecord): User {
  return User.restore({
    id: record.id,
    role: record.role,
    trustScore: record.trustScore,
    disputesCount: record.disputesCount,
    chargebacksCount: record.chargebacksCount,
    createdAt: new Date(record.createdAt),
  });
}

export class InMemoryUserRepository implements UserRepository {
  private readonly store = new Map<string, UserRecord>();

  async findById(id: string): Promise<User | null> {
    const record = this.store.get(id);
    if (!record) return null;
    return fromRecord(record);
  }

  async save(user: User): Promise<void> {
    this.store.set(user.id, toRecord(user));
  }
}
