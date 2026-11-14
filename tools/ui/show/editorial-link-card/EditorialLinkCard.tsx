import React from 'react';

/** A domain-blind link card with one shared content order across public surfaces. */
export interface EditorialLinkCardProps {
  href: string;
  title: string;
  thumbnailUrl?: string;
  thumbnailAlt?: string;
  description?: React.ReactNode;
  actionLabel: string;
  role?: React.AriaRole;
  className?: string;
  titleClassName?: string;
  descriptionClassName?: string;
  actionClassName?: string;
}

export function EditorialLinkCard({
  href,
  title,
  thumbnailUrl,
  thumbnailAlt,
  description,
  actionLabel,
  role,
  className,
  titleClassName,
  descriptionClassName,
  actionClassName,
}: EditorialLinkCardProps) {
  return (
    <a className={className} href={href} role={role}>
      {thumbnailUrl ? <img className="editorial-link-card__thumbnail" src={thumbnailUrl} alt={thumbnailAlt ?? ''} loading="lazy" /> : null}
      <h3 className={titleClassName}>{title}</h3>
      {description ? <p className={descriptionClassName}>{description}</p> : null}
      <span className={actionClassName}>{actionLabel}<span aria-hidden="true"> →</span></span>
    </a>
  );
}
