'use client';

import { useEffect, useState } from 'react';

const slides = [
  {
    src: '/images/carousel-trade.jpg',
    alt: 'Business partners shaking hands in a textile warehouse',
    eyebrow: 'Trade assurance',
    title: 'Build trust into every agreement',
  },
  {
    src: '/images/carousel-milestone.jpg',
    alt: 'Construction professional documenting an achieved milestone',
    eyebrow: 'Milestone control',
    title: 'Release value when work is verified',
  },
  {
    src: '/images/carousel-marketplace.jpg',
    alt: 'Online merchant carefully packing a customer order',
    eyebrow: 'Marketplace commerce',
    title: 'Protect buyers and sellers at every step',
  },
  {
    src: '/images/carousel-crossborder.jpg',
    alt: 'Shipping containers at an international cargo port',
    eyebrow: 'Cross-border payments',
    title: 'Move with confidence across markets',
  },
];

export function HeroCarousel() {
  const [activeSlide, setActiveSlide] = useState(0);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const interval = window.setInterval(() => {
      setActiveSlide((current) => (current + 1) % slides.length);
    }, 5000);

    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="hero-carousel" aria-roledescription="carousel" aria-label="AssuraPay use cases">
      <div className="hero-carousel__viewport" aria-live="polite">
        {slides.map((slide, index) => (
          <figure
            className={`hero-carousel__slide${index === activeSlide ? ' is-active' : ''}`}
            key={slide.src}
            aria-hidden={index !== activeSlide}
          >
            <img src={slide.src} alt={slide.alt} />
            <figcaption>
              <span>{slide.eyebrow}</span>
              <strong>{slide.title}</strong>
            </figcaption>
          </figure>
        ))}
      </div>
      <div className="hero-carousel__controls" aria-label="Choose a carousel slide">
        {slides.map((slide, index) => (
          <button
            className={index === activeSlide ? 'is-active' : ''}
            key={slide.src}
            type="button"
            aria-label={`Show slide ${index + 1}: ${slide.eyebrow}`}
            aria-current={index === activeSlide ? 'true' : undefined}
            onClick={() => setActiveSlide(index)}
          />
        ))}
      </div>
    </div>
  );
}
