// SelfPhotos AI tools: the presets (our own saved instructions), which of them can be picked
// together, how a highlighted area is marked and pasted back, and which photos AI edits take.
// Read from the web's ai-tools.json (assets/selfphotos/ai-tools.json links to it), as the web
// reads it (web/src/lib/ai-edit/ai/ai-tools.ts). Not part of Immich.
import 'dart:convert';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_geometry.dart';

/// 'optional': with a highlight, only that area changes; 'required': needs one (Move);
/// 'ignored': always the whole photo (styles, Auto frame).
enum AiHighlight { optional, required, ignored }

/// 'fix': several can be picked together; 'style': at most one (picking another swaps it).
enum AiGroup { fix, style }

class AiTool {
  final String id;
  final AiGroup group;
  final AiHighlight highlight;

  /// Never combined with another tool (Move).
  final bool alone;

  /// false: the whole result is used even with a highlight (Move, styles, Auto frame).
  final bool pasteBack;

  /// Needs a few words from the user, added to its instruction (Move: where to).
  final bool ask;
  final String instruction;

  const AiTool({
    required this.id,
    required this.group,
    required this.highlight,
    required this.alone,
    required this.pasteBack,
    required this.ask,
    required this.instruction,
  });

  factory AiTool.fromJson(Map<String, Object?> json) => AiTool(
    id: json['id']! as String,
    group: AiGroup.values.byName(json['group']! as String),
    highlight: AiHighlight.values.byName(json['highlight']! as String),
    alone: json['alone'] as bool? ?? false,
    pasteBack: json['pasteBack'] as bool? ?? true,
    ask: json['ask'] as bool? ?? false,
    instruction: json['instruction']! as String,
  );

  /// What's sent: its instruction, with the user's words for a tool that asks.
  String instructionWith(String words) => ask ? '$instruction ${words.trim()}' : instruction;

  String label(BuildContext context) => switch (id) {
    'enhance' => context.t.editor_ai_tool_enhance,
    'unblur' => context.t.editor_ai_tool_unblur,
    'relight' => context.t.editor_ai_tool_relight,
    'sky' => context.t.editor_ai_tool_sky,
    'erase' => context.t.editor_ai_tool_erase,
    'reflections' => context.t.editor_ai_tool_reflections,
    'glare' => context.t.editor_ai_tool_glare,
    'move' => context.t.editor_ai_tool_move,
    'reframe' => context.t.editor_ai_tool_reframe,
    'watercolour' => context.t.editor_ai_tool_watercolour,
    'sketch' => context.t.editor_ai_tool_sketch,
    'painting' => context.t.editor_ai_tool_painting,
    _ => id,
  };

  /// The hint for a tool that asks for words.
  String askHint(BuildContext context) => switch (id) {
    'move' => context.t.editor_ai_tool_move_ask,
    _ => context.t.editor_ai_describe,
  };

  // The web has its own (AiTools.svelte).
  IconData get icon => switch (id) {
    'enhance' => Icons.auto_fix_high,
    'unblur' => Icons.blur_off,
    'relight' => Icons.lightbulb_outline,
    'sky' => Icons.wb_cloudy_outlined,
    'erase' => Icons.cleaning_services_outlined,
    'reflections' => Icons.flip,
    'glare' => Icons.wb_sunny_outlined,
    'move' => Icons.open_with,
    'reframe' => Icons.crop_free,
    'watercolour' => Icons.water_drop_outlined,
    'sketch' => Icons.edit_outlined,
    'painting' => Icons.palette_outlined,
    _ => Icons.auto_awesome_outlined,
  };
}

/// How a highlighted area is marked for the AI and pasted back (ai_area.dart).
class AiAreaSettings {
  final int markLongSide;
  final double markQuality;
  final List<int> tint; // red, green, blue
  final double tintAlpha;
  final int maskLongSide;
  final double feather;
  final double shapeTolerance;

  /// Lining the result up (ai_align.dart): the size it's measured at, and the most the fit may
  /// still be off (a share of the photo's width) before nothing is pasted.
  final int alignLongSide;
  final double maxMisalignment;

  /// The upright photo sent with a highlighted edit (ai_area.dart uprightPhoto).
  final int photoLongSide;
  final double photoQuality;

  const AiAreaSettings({
    required this.markLongSide,
    required this.markQuality,
    required this.tint,
    required this.tintAlpha,
    required this.maskLongSide,
    required this.feather,
    required this.shapeTolerance,
    required this.alignLongSide,
    required this.maxMisalignment,
    required this.photoLongSide,
    required this.photoQuality,
  });

  factory AiAreaSettings.fromJson(Map<String, Object?> json) {
    final tint = (json['tint']! as List).cast<num>();
    return AiAreaSettings(
      markLongSide: (json['markLongSide']! as num).toInt(),
      markQuality: (json['markQuality']! as num).toDouble(),
      tint: [for (final value in tint.take(3)) value.toInt()],
      tintAlpha: tint[3].toDouble(),
      maskLongSide: (json['maskLongSide']! as num).toInt(),
      feather: (json['feather']! as num).toDouble(),
      shapeTolerance: (json['shapeTolerance']! as num).toDouble(),
      alignLongSide: (json['alignLongSide']! as num).toInt(),
      maxMisalignment: (json['maxMisalignment']! as num).toDouble(),
      photoLongSide: (json['photoLongSide']! as num).toInt(),
      photoQuality: (json['photoQuality']! as num).toDouble(),
    );
  }

  Color get tintColor => Color.fromARGB(255, tint[0], tint[1], tint[2]);
}

/// The typed words' length limit: a few words for a tool that asks (Move: where to), more
/// otherwise. As the web's MAX_ASK_WORDS and MAX_WORDS (ai-tools.ts).
const maxAskWords = 150;
const maxWords = 500;

/// A picture that counts as the photo at full size, for a highlighted edit's paste
/// (memento-extras /save-area checks the same): each side at least [fullSizeMinShare] of the
/// photo's as shown and not larger, the same orientation, and the same shape within
/// [fullSizeAspectTolerance]. So a RAW photo's full-size JPEG, a little smaller than the RAW,
/// counts; Immich's preview doesn't. As the web's FULL_SIZE.
const fullSizeMinShare = 0.9;
const fullSizeAspectTolerance = 0.01;

/// Whether [picture] is the photo ([width] × [height] as shown) at full size. A photo whose size
/// isn't known can't be compared: any picture counts. As the web's isFullSize.
bool isFullSize(AdjustSize picture, int? width, int? height) {
  if (width == null || height == null || width == 0 || height == 0) {
    return true;
  }
  bool side(int read, int photo) => read >= photo * fullSizeMinShare && read <= photo;
  final turned =
      (picture.width > picture.height && width < height) || (picture.width < picture.height && width > height);
  return side(picture.width, width) &&
      side(picture.height, height) &&
      !turned &&
      ((picture.width / picture.height) / (width / height) - 1).abs() <= fullSizeAspectTolerance;
}

/// Why a tool can't be picked now: it needs a highlight (Move), it changes the whole photo while
/// there's a highlight, or [AiToolkit.maxSelected] are already picked.
enum AiBlock { needsHighlight, wholeOnly, upTo }

/// Whether [tool] can be used with the highlight as it is: Move needs one, a whole-photo tool
/// needs none. As the web's fitsHighlight.
bool _fitsHighlight(AiTool tool, {required bool highlighted}) =>
    (tool.highlight != AiHighlight.required || highlighted) && (tool.highlight != AiHighlight.ignored || !highlighted);

class AiToolkit {
  final List<AiTool> tools;
  final AiAreaSettings area;

  /// How many tools one edit may combine.
  final int maxSelected;

  /// The largest photo AI edits take, by its size as Immich shows it (upright, with Immich's own
  /// crop): memento-extras refuses larger ones too (413, code 'photo_too_large',
  /// aiEditPhotoTooLarge). As the web's MAX_PHOTO (ai-tools.ts).
  final int maxMegapixels;
  final int maxLongSide;

  const AiToolkit({
    required this.tools,
    required this.area,
    required this.maxSelected,
    required this.maxMegapixels,
    required this.maxLongSide,
  });

  factory AiToolkit.parse(String source) {
    final json = jsonDecode(source) as Map<String, Object?>;
    return AiToolkit(
      tools: [for (final tool in json['tools']! as List) AiTool.fromJson(tool as Map<String, Object?>)],
      area: AiAreaSettings.fromJson(json['area']! as Map<String, Object?>),
      maxSelected: (json['maxSelected']! as num).toInt(),
      maxMegapixels: (json['maxMegapixels']! as num).toInt(),
      maxLongSide: (json['maxLongSide']! as num).toInt(),
    );
  }

  static Future<AiToolkit> load() async =>
      AiToolkit.parse(await rootBundle.loadString('assets/selfphotos/ai-tools.json'));

  /// Whether a photo ([width] × [height] as shown) is too large for AI edits: more than
  /// [maxMegapixels], or its longer side more than [maxLongSide]. Checked before anything is sent
  /// or paid for. A photo whose size isn't known isn't refused here. As the web's tooLargeForAi.
  bool tooLargeForAi(int? width, int? height) =>
      width != null && height != null && (width * height > maxMegapixels * 1000000 || max(width, height) > maxLongSide);

  // The picked tools that stay when [tool] is picked: one that goes [AiTool.alone] (Move) is never
  // combined (picking it clears the others, picking another clears it), and a style swaps the
  // picked style. As the web's keptWith.
  List<AiTool> _keptWith(List<AiTool> picked, AiTool tool) => tool.alone
      ? const []
      : [
          for (final other in picked)
            if (!other.alone && !(tool.group == AiGroup.style && other.group == AiGroup.style)) other,
        ];

  /// Why [tool] can't be added to [picked] now, or null if it can (or is picked, and can always
  /// be unpicked): Move needs a highlight, a whole-photo tool needs none, and once [maxSelected]
  /// are picked the rest wait for one to be unpicked (except another style, which swaps, and
  /// Move, which goes alone: [toggle]). As the web's blockedReason.
  AiBlock? blocked(AiTool tool, List<AiTool> picked, {required bool highlighted}) {
    if (picked.contains(tool)) {
      return null;
    }
    if (!_fitsHighlight(tool, highlighted: highlighted)) {
      return tool.highlight == AiHighlight.required ? AiBlock.needsHighlight : AiBlock.wholeOnly;
    }
    return _keptWith(picked, tool).length >= maxSelected ? AiBlock.upTo : null;
  }

  /// [picked] after tapping [tool], in this file's order: a picked tool is unpicked; otherwise
  /// it's added to the ones [_keptWith] keeps. At most [maxSelected]: past that, nothing changes.
  /// As the web's toggleTool.
  List<AiTool> toggle(List<AiTool> picked, AiTool tool) {
    if (picked.contains(tool)) {
      return [
        for (final other in picked)
          if (other != tool) other,
      ];
    }
    final kept = _keptWith(picked, tool);
    return kept.length < maxSelected
        ? [
            for (final other in tools)
              if (other == tool || kept.contains(other)) other,
          ]
        : picked;
  }
}

/// Whether Generate can send [picked] and [words]: a tool or some words, Move with its words and
/// a highlight, and a whole-photo tool without one. As the web's canGenerate.
bool canGenerate(List<AiTool> picked, String words, {required bool highlighted}) {
  final typed = words.trim().isNotEmpty;
  return (picked.isNotEmpty || typed) &&
      picked.every((tool) => _fitsHighlight(tool, highlighted: highlighted) && (!tool.ask || typed));
}

// The line before several items: a "keep ... the same" in one item allows the other items'
// changes.
const _severalHeader =
    'Make all of these changes to the photo in one edit. Where an item says to keep something the same, '
    'that means apart from the other changes in this list:';

/// What's sent for the picked [tools] (in ai-tools.json order) and the typed [words]: each tool's
/// instruction, then the words (for a tool that asks, Move, they're part of its own: where to).
/// A single one is sent as it is, so one preset or words alone send what they always did;
/// several as one list after a header, so they're made in one edit (and charged once). As the
/// web's combinedInstruction (ai-tools.ts).
String combinedInstruction(List<AiTool> tools, String words) {
  final text = words.trim();
  final items = [
    for (final tool in tools) tool.instructionWith(text),
    if (text.isNotEmpty && !tools.any((tool) => tool.ask)) text,
  ];
  return items.length > 1 ? '$_severalHeader\n${items.map((item) => '- $item').join('\n')}' : items.firstOrNull ?? '';
}

/// A result's label: the picked [tools]' names (in ai-tools.json order), then the [words], joined
/// with " + "; Move (a tool that asks) with its words after a colon, as its label always was:
/// "Move: to the left". As the web's combinedLabel.
String combinedLabel(List<AiTool> tools, String words, String Function(AiTool tool) nameOf) {
  final text = words.trim();
  return [
    for (final tool in tools) tool.ask ? '${nameOf(tool)}: $text' : nameOf(tool),
    if (text.isNotEmpty && !tools.any((tool) => tool.ask)) text,
  ].join(' + ');
}
