import { atom, read, set, update } from 'orca'
import { sameArm, type ArmIdentity } from '../shared/work'

const currentArm = atom<ArmIdentity | null>(null)
let heard = 0

export function acceptArm(arm: ArmIdentity | null): void {
  heard += 1
  set(currentArm, arm)
}

export const isArmed = (arm: ArmIdentity): boolean => sameArm(read(currentArm), arm)

async function afterAnswer<T>(request: Promise<T>, next: (current: ArmIdentity | null, answer: T) => ArmIdentity | null): Promise<T> {
  const before = heard
  const answer = await request
  // A post heard while the request ran is at least as new as its answer.
  if (heard === before) update(currentArm, current => next(current, answer))
  return answer
}

export const requestArm = <T,>(request: Promise<T>, armOf: (answer: T) => ArmIdentity | null): Promise<T> =>
  afterAnswer(request, (current, answer) => armOf(answer) ?? current)

export const requestDisarm = <T,>(request: Promise<T>, arm: ArmIdentity): Promise<T> =>
  afterAnswer(request, current => (sameArm(current, arm) ? null : current))
