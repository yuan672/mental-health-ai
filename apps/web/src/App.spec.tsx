import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('renders the bootstrap status without claiming medical capability', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: '心理健康 AI 支持系统' })).toBeInTheDocument();
    expect(screen.getByText(/不是医疗诊断系统/)).toBeInTheDocument();
  });
});
