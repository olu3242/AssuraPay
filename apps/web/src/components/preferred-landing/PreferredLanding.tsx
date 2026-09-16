'use client';

import { useEffect, useRef } from 'react';
import { landingMarkup } from './markup';

/** Enhances the supplied static design without executing its embedded scripts. */
export default function PreferredLanding() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const toggle = element.querySelector<HTMLButtonElement>('#menuToggle');
    const menu = element.querySelector<HTMLElement>('#mobile-menu');
    function setMenu(open: boolean) {
      menu?.classList.toggle('open', open);
      toggle?.setAttribute('aria-expanded', String(open));
      toggle?.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      const opened = element!.querySelector<HTMLElement>('#menuIconOpen');
      const closed = element!.querySelector<HTMLElement>('#menuIconClose');
      if (opened) opened.style.display = open ? 'none' : 'block';
      if (closed) closed.style.display = open ? 'block' : 'none';
    }
    function selectTab(tab: HTMLElement) {
      tab
        .closest('[role="tablist"]')
        ?.querySelectorAll<HTMLElement>('[role="tab"]')
        .forEach((item) => {
          const active = item === tab;
          item.setAttribute('aria-selected', String(active));
          item.tabIndex = active ? 0 : -1;
          const panel = element!.querySelector<HTMLElement>(
            '#' + item.getAttribute('aria-controls'),
          );
          if (panel) {
            panel.hidden = !active;
            panel.classList.toggle('active', active);
          }
        });
    }
    element.querySelectorAll<HTMLElement>('[role="tab"]').forEach((tab) => {
      tab.tabIndex = tab.getAttribute('aria-selected') === 'true' ? 0 : -1;
    });
    element.querySelectorAll<HTMLElement>('.faq-q').forEach((button, index) => {
      const answer = button.nextElementSibling as HTMLElement;
      answer.id = `preferred-faq-${index}`;
      button.setAttribute('aria-controls', answer.id);
      const open = button.getAttribute('aria-expanded') === 'true';
      answer.hidden = !open;
      answer.classList.toggle('is-open', open);
    });
    const year = element.querySelector('#year');
    if (year) year.textContent = String(new Date().getFullYear());
    function click(event: MouseEvent) {
      const target = event.target as Element;
      if (target.closest('[aria-disabled="true"]')) {
        event.preventDefault();
        return;
      }
      if (target.closest('#menuToggle'))
        setMenu(!menu?.classList.contains('open'));
      if (target.closest('#mobile-menu a')) setMenu(false);
      const tab = target.closest<HTMLElement>('[role="tab"]');
      if (tab) selectTab(tab);
      const faq = target.closest<HTMLElement>('.faq-q');
      if (faq) {
        const open = faq.getAttribute('aria-expanded') !== 'true';
        faq.setAttribute('aria-expanded', String(open));
        const answer = faq.nextElementSibling as HTMLElement;
        answer.hidden = !open;
        answer.classList.toggle('is-open', open);
      }
    }
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape' && menu?.classList.contains('open')) {
        setMenu(false);
        toggle?.focus();
      }
      const tab = (event.target as Element).closest<HTMLElement>(
        '[role="tab"]',
      );
      if (
        !tab ||
        ![
          'ArrowRight',
          'ArrowLeft',
          'ArrowDown',
          'ArrowUp',
          'Home',
          'End',
        ].includes(event.key)
      )
        return;
      const tabs = Array.from(
        tab
          .closest('[role="tablist"]')!
          .querySelectorAll<HTMLElement>('[role="tab"]'),
      );
      const index = tabs.indexOf(tab);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : (index +
                (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) +
                tabs.length) %
              tabs.length;
      event.preventDefault();
      tabs[next].focus();
      selectTab(tabs[next]);
    }
    element.addEventListener('click', click);
    element.addEventListener('keydown', keydown);
    return () => {
      element.removeEventListener('click', click);
      element.removeEventListener('keydown', keydown);
    };
  }, []);
  return (
    <div
      id="preferred-landing"
      ref={root}
      dangerouslySetInnerHTML={{ __html: landingMarkup }}
    />
  );
}
