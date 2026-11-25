// SelfPhotos Adjust: Perspective's four corners, on the photo shown whole and unwarped (the same
// as the web's AdjustPerspective.svelte). Each is dragged onto a line that should be straight,
// such as a building's edge; outside them is dimmed, and a magnifier above the finger shows the
// spot under it. The photo is then warped so the four make a rectangle (adjust_geometry.dart),
// which shows when the Straighten mode is chosen again. A move that would bring corners too close,
// cross them over, or stretch the photo too far, is refused, and a brief message says so (once a
// drag). Not part of Immich.
import 'package:flutter/material.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_geometry.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';

class PerspectiveCorners extends StatefulWidget {
  /// Where the photo is, inside this widget (which may be larger, so a corner on the photo's edge
  /// can be grabbed from outside it too).
  final Rect photo;

  /// The corners, or null for the photo's own.
  final Quad? corners;
  final bool enabled;
  final ValueChanged<Quad> onChanged;

  const PerspectiveCorners({
    super.key,
    required this.photo,
    required this.corners,
    required this.enabled,
    required this.onChanged,
  });

  /// How far from a corner a finger still picks it up.
  static const reach = 48.0;
  static const _magnifier = 112.0;

  @override
  State<PerspectiveCorners> createState() => _PerspectiveCornersState();
}

class _PerspectiveCornersState extends State<PerspectiveCorners> {
  // The corner being dragged, how far the finger is from its exact spot, and where the finger is.
  int? _dragging;
  Offset _offset = Offset.zero;
  Offset? _finger;
  // This drag has said a move was refused.
  bool _hinted = false;

  Quad get _corners => widget.corners ?? photoCorners();

  Offset _onScreen(AdjustPoint corner) =>
      widget.photo.topLeft + Offset(corner.$1 * widget.photo.width, corner.$2 * widget.photo.height);

  void _start(DragStartDetails details) {
    final at = details.localPosition;
    int? nearest;
    var distance = PerspectiveCorners.reach;
    for (final (index, corner) in _corners.indexed) {
      final d = (_onScreen(corner) - at).distance;
      if (d <= distance) {
        nearest = index;
        distance = d;
      }
    }
    _hinted = false;
    setState(() {
      _dragging = nearest;
      _offset = nearest == null ? Offset.zero : _onScreen(_corners[nearest]) - at;
      _finger = nearest == null ? null : at;
    });
  }

  void _move(DragUpdateDetails details) {
    final index = _dragging;
    if (index == null) {
      return;
    }
    setState(() => _finger = details.localPosition);
    final spot = details.localPosition + _offset - widget.photo.topLeft;
    final corner = ((spot.dx / widget.photo.width).clamp(0.0, 1.0), (spot.dy / widget.photo.height).clamp(0.0, 1.0));
    final next = [for (final (i, c) in _corners.indexed) i == index ? corner : c];
    if (isValidPerspective(next)) {
      widget.onChanged(next);
    } else if (!_hinted) {
      _hinted = true;
      ImmichToast.show(context: context, msg: context.t.editor_perspective_too_small, durationInSecond: 2);
    }
  }

  void _end() => setState(() {
    _dragging = null;
    _finger = null;
  });

  @override
  Widget build(BuildContext context) {
    final finger = _finger;
    final dragging = _dragging;
    const size = PerspectiveCorners._magnifier;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onPanStart: widget.enabled ? _start : null,
      onPanUpdate: widget.enabled ? _move : null,
      onPanEnd: widget.enabled ? (_) => _end() : null,
      onPanCancel: widget.enabled ? _end : null,
      child: Stack(
        fit: StackFit.expand,
        children: [
          CustomPaint(
            painter: _CornersPainter(
              photo: widget.photo,
              corners: [for (final corner in _corners) _onScreen(corner)],
              dragging: dragging,
              colour: context.primaryColor,
            ),
          ),
          // Above the finger (below it near the top), showing the spot under it twice as large.
          if (finger != null && dragging != null)
            () {
              final spot = _onScreen(_corners[dragging]);
              final above = spot.dy - size * 1.2 > 0;
              final centre = Offset(spot.dx, above ? spot.dy - size * 0.95 : spot.dy + size * 0.95);
              return Positioned(
                left: centre.dx - size / 2,
                top: centre.dy - size / 2,
                child: RawMagnifier(
                  size: const Size.square(size),
                  magnificationScale: 2,
                  focalPointOffset: spot - centre,
                  decoration: const MagnifierDecoration(
                    shape: CircleBorder(side: BorderSide(color: Colors.white, width: 2)),
                    shadows: [BoxShadow(color: Colors.black54, blurRadius: 6)],
                  ),
                  child: const Center(
                    child: SizedBox.square(
                      dimension: 8,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          border: Border.fromBorderSide(BorderSide(color: Colors.white, width: 1.5)),
                        ),
                      ),
                    ),
                  ),
                ),
              );
            }(),
        ],
      ),
    );
  }
}

class _CornersPainter extends CustomPainter {
  final Rect photo;
  final List<Offset> corners;
  final int? dragging;
  final Color colour;

  const _CornersPainter({required this.photo, required this.corners, required this.dragging, required this.colour});

  @override
  void paint(Canvas canvas, Size size) {
    final outline = Path()..addPolygon(corners, true);
    canvas.drawPath(
      Path()
        ..fillType = PathFillType.evenOdd
        ..addRect(photo)
        ..addPath(outline, Offset.zero),
      Paint()..color = Colors.black45,
    );
    canvas.drawPath(
      outline,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3
        ..color = Colors.black54,
    );
    canvas.drawPath(
      outline,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5
        ..color = Colors.white,
    );
    for (final (index, corner) in corners.indexed) {
      if (index == dragging) {
        // A ring, so the photo under it shows (in the magnifier too).
        for (final (width, ring) in [(4.5, Colors.black87), (2.0, Colors.white)]) {
          canvas.drawCircle(
            corner,
            16,
            Paint()
              ..style = PaintingStyle.stroke
              ..strokeWidth = width
              ..color = ring,
          );
        }
        continue;
      }
      canvas.drawCircle(corner, 12.5, Paint()..color = Colors.black87);
      canvas.drawCircle(corner, 11, Paint()..color = Colors.white);
      canvas.drawCircle(corner, 8.5, Paint()..color = colour);
    }
  }

  @override
  bool shouldRepaint(_CornersPainter old) =>
      old.photo != photo || old.dragging != dragging || old.colour != colour || !_same(old.corners, corners);

  static bool _same(List<Offset> a, List<Offset> b) =>
      a.length == b.length && [for (var i = 0; i < a.length; i++) a[i] == b[i]].every((same) => same);
}
