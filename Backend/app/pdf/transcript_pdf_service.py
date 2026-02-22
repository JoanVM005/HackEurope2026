from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from app.intake_voice.schemas import VoiceIntakeSlots


class TranscriptPdfService:
    def build_pdf(
        self,
        session_id: str,
        slots: VoiceIntakeSlots,
        turns: list[dict[str, str]],
        generated_at: datetime | None = None,
    ) -> bytes:
        timestamp = generated_at or datetime.now(timezone.utc)

        buffer = BytesIO()
        pdf = canvas.Canvas(buffer, pagesize=A4)
        width, height = A4

        y = height - 40
        line_height = 15

        def draw_line(text: str, bold: bool = False) -> None:
            nonlocal y
            if y < 50:
                pdf.showPage()
                y = height - 40
            font = "Helvetica-Bold" if bold else "Helvetica"
            pdf.setFont(font, 10)
            pdf.drawString(40, y, text[:120])
            y -= line_height

        draw_line("Cliniclár - Voice Intake Transcript", bold=True)
        draw_line(f"Session: {session_id}")
        draw_line(f"Generated at (UTC): {timestamp.isoformat()}")
        y -= 8

        draw_line("Extracted fields", bold=True)
        draw_line(f"First name: {slots.first_name or '-'}")
        draw_line(f"Last name: {slots.last_name or '-'}")
        draw_line(f"Description: {slots.description or '-'}")
        draw_line(f"Time preference: {slots.time_preferences or '-'}")
        y -= 8

        draw_line("Conversation", bold=True)
        for turn in turns:
            speaker = turn.get("speaker", "unknown")
            content = turn.get("content", "")
            chunks = self._wrap_text(content, max_chars=100)
            if not chunks:
                draw_line(f"[{speaker}]", bold=True)
                continue

            draw_line(f"[{speaker}] {chunks[0]}", bold=True)
            for chunk in chunks[1:]:
                draw_line(f"    {chunk}")

        pdf.save()
        buffer.seek(0)
        return buffer.read()

    @staticmethod
    def _wrap_text(text: str, max_chars: int) -> list[str]:
        cleaned = " ".join((text or "").split())
        if not cleaned:
            return []

        words = cleaned.split(" ")
        lines: list[str] = []
        current = ""
        for word in words:
            candidate = f"{current} {word}".strip()
            if len(candidate) <= max_chars:
                current = candidate
                continue
            if current:
                lines.append(current)
            current = word

        if current:
            lines.append(current)

        return lines
