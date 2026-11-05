import { Button, Callout, Row, Stack, Text, type OrcaNode } from 'orca'

export function SnapshotMessage({ message, stale }: { message?: string; stale: boolean }): OrcaNode {
  if (!message) return null
  return stale ? (
    <Text size="sm" tone="warning">
      {message}
    </Text>
  ) : (
    <Text size="sm" muted>
      {message}
    </Text>
  )
}

export function LoadFailure({ message, onRetry }: { message: string; onRetry: () => unknown }): OrcaNode {
  return (
    <Stack gap="sm">
      <Callout tone="danger">{message}</Callout>
      <Row gap="sm">
        <Button onPress={onRetry}>Try again</Button>
      </Row>
    </Stack>
  )
}
