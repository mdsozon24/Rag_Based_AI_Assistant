import { Button } from './button';

/** "Load more" for cursor lists; says when everything is shown. */
export function LoadMore({ hasNextPage, isFetchingNextPage, fetchNextPage, count, noun }: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown; count: number; noun: string }) {
  return (
    <div className="mt-4 flex items-center justify-between gap-3 text-sm text-muted">
      <span aria-live="polite">
        {count} {noun}
        {count === 1 ? '' : 's'} shown
      </span>
      {hasNextPage ? (
        <Button size="sm" onClick={() => void fetchNextPage()} loading={isFetchingNextPage}>
          Load more
        </Button>
      ) : null}
    </div>
  );
}
