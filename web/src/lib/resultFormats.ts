import type { ResultFormat } from '@/lib/types'

export interface FormatOption {
  value: ResultFormat
  label: string
  /** What it is good for, in one line. */
  blurb: string
  /** What a two-row result looks like in this format. */
  sample: string
  language: 'json' | 'text'
}

// The same two rows in every format, so the options can be compared at a glance.
export const RESULT_FORMATS: FormatOption[] = [
  {
    value: 'compact',
    label: 'Compact JSON',
    blurb: 'Column names once, then each row as an array. The fewest tokens.',
    sample: '{"columns":["id","email","total"],"rows":[[1,"ada@example.com",42.5],[2,"lin@example.com",null]],"row_count":2}',
    language: 'json',
  },
  {
    value: 'objects',
    label: 'JSON objects',
    blurb: 'One object per row. Self-describing, at the cost of repeating every column name.',
    sample:
      '{"rows":[{"id":1,"email":"ada@example.com","total":42.5},{"id":2,"email":"lin@example.com","total":null}],"row_count":2}',
    language: 'json',
  },
  {
    value: 'markdown',
    label: 'Markdown table',
    blurb: 'Reads well when the client shows results to a person as-is.',
    sample:
      '| id | email | total |\n| --- | --- | --- |\n| 1 | ada@example.com | 42.5 |\n| 2 | lin@example.com | NULL |\n\n2 rows',
    language: 'text',
  },
  {
    value: 'csv',
    label: 'CSV',
    blurb: 'A header row and plain values. Compact, and easy to hand to other tools.',
    sample: 'id,email,total\n1,ada@example.com,42.5\n2,lin@example.com,',
    language: 'text',
  },
]

export const formatLabel = (format: ResultFormat) =>
  RESULT_FORMATS.find((option) => option.value === format)?.label ?? format
