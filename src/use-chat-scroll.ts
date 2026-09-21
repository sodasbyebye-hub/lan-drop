import { useLayoutEffect, useRef } from "react";

export function useChatScroll(conversation: string, messageCount: number, historyRevision: number) {
  const messagesRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);

  useLayoutEffect(() => {
    const area = messagesRef.current;
    const content = contentRef.current;
    if (!area || !content) return;

    const scrollToBottom = () => {
      if (followBottom.current) area.scrollTop = area.scrollHeight;
    };
    const onScroll = () => {
      followBottom.current = area.scrollHeight - area.clientHeight - area.scrollTop <= 24;
    };
    const onPageShow = () => {
      followBottom.current = true;
      scrollToBottom();
    };
    // Media loading, font changes and the mobile keyboard can change layout
    // after history has rendered. Keep following unless the user scrolls away.
    const observer = new ResizeObserver(scrollToBottom);
    observer.observe(area);
    observer.observe(content);
    area.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pageshow", onPageShow);
    return () => {
      observer.disconnect();
      area.removeEventListener("scroll", onScroll);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  useLayoutEffect(() => {
    followBottom.current = true;
    const scrollToBottom = () => {
      const area = messagesRef.current;
      if (area && followBottom.current) area.scrollTop = area.scrollHeight;
    };
    // Initial history and conversation changes should land immediately at the
    // latest message, without a smooth animation through the entire history.
    scrollToBottom();
    const frame = requestAnimationFrame(scrollToBottom);
    return () => cancelAnimationFrame(frame);
  }, [conversation, messageCount, historyRevision]);

  return { messagesRef, contentRef };
}
