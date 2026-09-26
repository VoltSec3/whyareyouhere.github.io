import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

type AnimateInProps = {
  children: ReactNode;
  className?: string;
  delay?: number;
  disableAnimation?: boolean;
};

export function AnimateIn({
  children,
  className,
  delay = 0,
  disableAnimation = false,
}: AnimateInProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(disableAnimation);

  useEffect(() => {
    if (disableAnimation) return;

    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          const timer = window.setTimeout(() => setVisible(true), delay);
          observer.disconnect();
          return () => window.clearTimeout(timer);
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [delay, disableAnimation]);

  return (
    <div
      ref={ref}
      className={cn(
        !disableAnimation && "transition-all duration-700 ease-out",
        !disableAnimation && (visible ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"),
        disableAnimation && "translate-y-0 opacity-100",
        className,
      )}
    >
      {children}
    </div>
  );
}
