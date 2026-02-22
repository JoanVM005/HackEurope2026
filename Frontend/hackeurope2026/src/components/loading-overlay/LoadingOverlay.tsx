import './loadingOverlay.css'

interface LoadingOverlayProps {
  open: boolean
  message: string
  ariaLabel?: string
}

export default function LoadingOverlay({ open, message, ariaLabel = 'Loading' }: LoadingOverlayProps) {
  if (!open) return null

  return (
    <div className="loading-overlay" role="status" aria-live="polite" aria-label={ariaLabel}>
      <div className="loading-overlay__modal">
        <span className="loading-overlay__spinner" aria-hidden />
        <p>{message}</p>
      </div>
    </div>
  )
}
