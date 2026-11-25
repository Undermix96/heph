// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Snippet } from './features/search/SearchPage.js';

// Independent verification, phase 4 group B (search). The input is what the real server
// returned for an invented diary note (packages/core/src/search.ts escapes as &#NN;).
afterEach(() => cleanup());

describe('verifyB search snippet', () => {
  it('decodes the numeric entities the server sends for & < > and quotes', () => {
    const { container } = render(
      <Snippet
        html={
          'Oggi ho tagliato le <mark>gambe</mark> della sedia &#38; pulito &#60;tutto&#62; &#34;bene&#34; l&#39;altro'
        }
      />,
    );
    expect(container.querySelectorAll('mark')).toHaveLength(1);
    expect(container.textContent).toBe(
      'Oggi ho tagliato le gambe della sedia & pulito <tutto> "bene" l\'altro',
    );
  });
});
