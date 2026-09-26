import com.bedatadriven.jackson.datatype.jts.JtsModule;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.geom.GeometryFactory;
import org.locationtech.jts.geom.LineString;
import org.locationtech.jts.geom.Polygonal;
import org.locationtech.jts.geom.prep.PreparedGeometry;
import org.locationtech.jts.geom.prep.PreparedGeometryFactory;
import org.locationtech.jts.geom.util.GeometryFixer;
import org.locationtech.jts.geom.util.PolygonExtracter;
import org.locationtech.jts.index.strtree.STRtree;
import org.locationtech.jts.operation.union.UnaryUnionOp;

/**
 * M2-01ay: close every place where a walkable way crosses the perimeter of a mapped military area,
 * in the OSM data the graph is imported from.
 *
 * <pre>
 *   java -cp graphhopper-web.jar scripts/geo/MilitaryPerimeterBarriers.java \
 *     military.geojsonseq ways-with-locations.opl changes.osc
 * </pre>
 *
 * Started by scripts/build-routing-graph.mts through graphhopperToolJavaArguments (the launch
 * helper), never by hand. It runs on the classpath of the pinned GraphHopper jar for its geometry
 * library (JTS 1.19). Nothing here starts the engine.
 *
 * Inputs, both from the pinned extract with osmium:
 *
 * - the areas tagged `landuse=military` or `military=*` (`osmium export`, polygons);
 * - the ways GraphHopper's foot parser can use (`highway=*` except the ignored motorway and trunk,
 *   `route=ferry`, `man_made=pier`, `railway=platform`) with their node locations
 *   (`osmium add-locations-to-ways`, OPL).
 *
 * The areas are repaired and merged first, so a way from one military area into an adjoining one
 * crosses no perimeter, and one into a nested area (the Joint Security Area inside the DMZ) is
 * inside already. Then, for every way segment that meets the perimeter of the merged areas, a NEW
 * node is inserted into the way at the meeting point: `barrier=gate`, `access=no`, `foot=no`,
 * `m2_01ay:military_perimeter=yes`. GraphHopper splits a way at a barrier node and gives the
 * barrier edge no foot access when the node's `foot` value is restricted
 * (AbstractAccessParser.isBarrier), so no walking route can pass the meeting point: none enters or
 * leaves a military area. The roads inside stay in the graph, so a point inside a base still snaps
 * to the road it is on and a request into one answers `no_route`.
 *
 * When the meeting point is a node the way already has, the new node goes 1e-6 degrees (about
 * 0.1 m) along the segment from it, on every segment of the way that touches the perimeter there,
 * so the existing node, possibly a junction, keeps its tags and its role. A segment that runs along
 * the perimeter gets a node at each end of the shared stretch.
 *
 * A way the foot parser already closes (a restricted `foot` value, or a restricted `access` value
 * with no `foot` value) is left alone: it carries no walking route anyway.
 *
 * Output: an osmChange document (`<create>` for the new nodes, `<modify>` for the ways, each with
 * its version raised by one) for `osmium apply-changes`, and a one-line JSON summary on stdout.
 * New node ids start at 20,000,000,000, above every node id the ways refer to (checked here) and above
 * the extract's largest node id (checked by the build). The output
 * is a function of the input bytes: ways are read in file order, new ids are given in that order.
 *
 * Why in the data and not in the profile: a GraphHopper 10.0 custom-model area is re-serialised as
 * WKT whenever a request builds its weighting, and tested on every edge the search relaxes. Measured
 * in M2-01ay with the perimeter marks as an area, a 12-waypoint route took about 3x as long
 * (steady 64-135 ms instead of 20-35 ms, first round 238 ms instead of 76 ms). A barrier node costs
 * nothing per request.
 */
public final class MilitaryPerimeterBarriers {
  private MilitaryPerimeterBarriers() {}

  static final long FIRST_NEW_NODE_ID = 20_000_000_000L;
  /** How far from an existing node a barrier on it is placed along the segment, in degrees. */
  static final double OFFSET_DEGREES = 1e-6;
  /** A meeting point this close to a segment end is that end. */
  static final double SAME_POINT_DEGREES = 1e-7;

  /** GraphHopper 10.0 FootAccessParser's restrictedValues. */
  static final Set<String> CLOSED =
      Set.of("no", "restricted", "military", "emergency", "private", "permit");

  record Way(long id, int version, Map<String, String> tags, long[] nodes, double[] xs, double[] ys) {}

  public static void main(String[] args) throws IOException {
    if (args.length != 3) {
      System.err.println(
          "usage: MilitaryPerimeterBarriers <military.geojsonseq> <ways-with-locations.opl> <changes.osc>");
      System.exit(2);
    }
    ObjectMapper mapper = new ObjectMapper().registerModule(new JtsModule());
    GeometryFactory factory = new GeometryFactory();

    // 1. The military areas, repaired and merged.
    List<Geometry> polygons = new ArrayList<>();
    int militaryFeatures = 0;
    int skippedFeatures = 0;
    try (BufferedReader reader = Files.newBufferedReader(Path.of(args[0]), StandardCharsets.UTF_8)) {
      String line;
      while ((line = reader.readLine()) != null) {
        String text = line.startsWith("\u001e") ? line.substring(1) : line;
        if (text.isBlank()) continue;
        JsonNode feature = mapper.readTree(text);
        JsonNode properties = feature.path("properties");
        JsonNode geometryNode = feature.get("geometry");
        boolean military =
            "military".equals(properties.path("landuse").asText(null)) || properties.hasNonNull("military");
        Geometry geometry =
            geometryNode == null || geometryNode.isNull()
                ? null
                : mapper.treeToValue(geometryNode, Geometry.class);
        if (!military || !(geometry instanceof Polygonal)) {
          skippedFeatures += 1;
          continue;
        }
        militaryFeatures += 1;
        for (Object part : PolygonExtracter.getPolygons(GeometryFixer.fix(geometry)))
          polygons.add((Geometry) part);
      }
    }

    // 2. The perimeter of the merged areas, one indexed piece per polygon.
    STRtree index = new STRtree();
    int unionPolygons = 0;
    if (!polygons.isEmpty()) {
      Geometry area = UnaryUnionOp.union(polygons);
      if (!(area instanceof Polygonal)) throw new IllegalStateException("UNION_NOT_POLYGONAL");
      for (Object part : PolygonExtracter.getPolygons(area)) {
        Geometry boundary = ((Geometry) part).getBoundary();
        index.insert(boundary.getEnvelopeInternal(), PreparedGeometryFactory.prepare(boundary));
        unionPolygons += 1;
      }
    }
    index.build();

    // 3. Ways: find the segments that meet the perimeter, insert barrier nodes.
    long nextId = FIRST_NEW_NODE_ID;
    long maxNodeIdSeen = 0;
    int waysRead = 0;
    int closedWays = 0;
    int waysChanged = 0;
    int barrierNodes = 0;
    Path out = Path.of(args[2]);
    try (BufferedReader reader = Files.newBufferedReader(Path.of(args[1]), StandardCharsets.UTF_8);
        BufferedWriter creates = Files.newBufferedWriter(Path.of(args[2] + ".create"), StandardCharsets.UTF_8);
        BufferedWriter modifies = Files.newBufferedWriter(Path.of(args[2] + ".modify"), StandardCharsets.UTF_8)) {
      String line;
      while ((line = reader.readLine()) != null) {
        if (!line.startsWith("w")) continue;
        Way way = parseWay(line);
        waysRead += 1;
        for (long node : way.nodes()) maxNodeIdSeen = Math.max(maxNodeIdSeen, node);
        if (way.nodes().length < 2) continue;
        if (closedToPedestrians(way.tags())) {
          closedWays += 1;
          continue;
        }
        Coordinate[] coordinates = new Coordinate[way.nodes().length];
        for (int i = 0; i < coordinates.length; i++)
          coordinates[i] = new Coordinate(way.xs()[i], way.ys()[i]);
        LineString whole = factory.createLineString(coordinates);
        List<PreparedGeometry> near = new ArrayList<>();
        for (Object candidate : index.query(whole.getEnvelopeInternal())) {
          PreparedGeometry boundary = (PreparedGeometry) candidate;
          if (boundary.intersects(whole)) near.add(boundary);
        }
        if (near.isEmpty()) continue;

        List<Long> refs = new ArrayList<>();
        List<double[]> created = new ArrayList<>();
        refs.add(way.nodes()[0]);
        for (int i = 1; i < coordinates.length; i++) {
          Coordinate a = coordinates[i - 1];
          Coordinate b = coordinates[i];
          double length = a.distance(b);
          List<Double> positions = new ArrayList<>();
          if (length > 0) {
            LineString segment = factory.createLineString(new Coordinate[] {a, b});
            for (PreparedGeometry boundary : near) {
              if (!boundary.intersects(segment)) continue;
              Geometry meeting = segment.intersection(boundary.getGeometry());
              for (Coordinate point : meeting.getCoordinates()) {
                double along = Math.max(0, Math.min(1, projection(a, b, point) / length));
                double distanceFromA = along * length;
                if (distanceFromA <= SAME_POINT_DEGREES) along = Math.min(0.5, OFFSET_DEGREES / length);
                else if (length - distanceFromA <= SAME_POINT_DEGREES)
                  along = Math.max(0.5, 1 - OFFSET_DEGREES / length);
                positions.add(along);
              }
            }
          }
          positions.sort(Comparator.naturalOrder());
          double previous = -1;
          for (double along : positions) {
            if (along - previous < 1e-9) continue;
            previous = along;
            double x = round7(a.x + (b.x - a.x) * along);
            double y = round7(a.y + (b.y - a.y) * along);
            long id = nextId++;
            refs.add(id);
            created.add(new double[] {id, x, y});
          }
          refs.add(way.nodes()[i]);
        }
        if (created.isEmpty()) continue;
        waysChanged += 1;
        barrierNodes += created.size();
        for (double[] node : created)
          creates.write(
              String.format(
                  Locale.ROOT,
                  "  <node id=\"%d\" version=\"1\" lat=\"%.7f\" lon=\"%.7f\">\n"
                      + "    <tag k=\"barrier\" v=\"gate\"/>\n"
                      + "    <tag k=\"access\" v=\"no\"/>\n"
                      + "    <tag k=\"foot\" v=\"no\"/>\n"
                      + "    <tag k=\"m2_01ay:military_perimeter\" v=\"yes\"/>\n"
                      + "  </node>\n",
                  (long) node[0],
                  node[2],
                  node[1]));
        StringBuilder modified = new StringBuilder();
        modified.append(String.format(Locale.ROOT, "  <way id=\"%d\" version=\"%d\">\n", way.id(), way.version() + 1));
        for (long ref : refs) modified.append("    <nd ref=\"").append(ref).append("\"/>\n");
        for (Map.Entry<String, String> tag : way.tags().entrySet())
          modified
              .append("    <tag k=\"")
              .append(xml(tag.getKey()))
              .append("\" v=\"")
              .append(xml(tag.getValue()))
              .append("\"/>\n");
        modified.append("  </way>\n");
        modifies.write(modified.toString());
      }
    }
    if (maxNodeIdSeen >= FIRST_NEW_NODE_ID) throw new IllegalStateException("NODE_IDS_OVERLAP_NEW_IDS");
    try (BufferedWriter writer = Files.newBufferedWriter(out, StandardCharsets.UTF_8)) {
      writer.write("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
      writer.write("<osmChange version=\"0.6\" generator=\"MilitaryPerimeterBarriers (M2-01ay)\">\n<create>\n");
      writer.write(Files.readString(Path.of(args[2] + ".create"), StandardCharsets.UTF_8));
      writer.write("</create>\n<modify>\n");
      writer.write(Files.readString(Path.of(args[2] + ".modify"), StandardCharsets.UTF_8));
      writer.write("</modify>\n</osmChange>\n");
    }
    Files.delete(Path.of(args[2] + ".create"));
    Files.delete(Path.of(args[2] + ".modify"));

    Map<String, Object> summary = new LinkedHashMap<>();
    summary.put("militaryFeatures", militaryFeatures);
    summary.put("skippedMilitaryFeatures", skippedFeatures);
    summary.put("militaryPolygonsAfterUnion", unionPolygons);
    summary.put("waysRead", waysRead);
    summary.put("waysClosedToPedestriansSkipped", closedWays);
    summary.put("waysGivenBarriers", waysChanged);
    summary.put("barrierNodes", barrierNodes);
    summary.put("firstNewNodeId", FIRST_NEW_NODE_ID);
    System.out.println(mapper.writeValueAsString(summary));
  }

  static boolean closedToPedestrians(Map<String, String> tags) {
    String foot = tags.get("foot");
    if (foot != null) return CLOSED.contains(foot);
    String access = tags.get("access");
    return access != null && CLOSED.contains(access);
  }

  private static double projection(Coordinate a, Coordinate b, Coordinate p) {
    double dx = b.x - a.x;
    double dy = b.y - a.y;
    double length = Math.hypot(dx, dy);
    return ((p.x - a.x) * dx + (p.y - a.y) * dy) / length;
  }

  private static double round7(double value) {
    return Math.round(value * 1e7) / 1e7;
  }

  private static String xml(String text) {
    return text.replace("&", "&amp;")
        .replace("\"", "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\n", "&#10;")
        .replace("\r", "&#13;")
        .replace("\t", "&#9;");
  }

  /** OSM's OPL escape: `%<hex code point>%`. */
  static String decodeOpl(String text) {
    StringBuilder out = new StringBuilder();
    int i = 0;
    while (i < text.length()) {
      char c = text.charAt(i);
      if (c == '%') {
        int end = text.indexOf('%', i + 1);
        out.appendCodePoint(Integer.parseInt(text.substring(i + 1, end), 16));
        i = end + 1;
      } else {
        out.append(c);
        i += 1;
      }
    }
    return out.toString();
  }

  /** `w<id> v<version> ... T<k=v,...> N<n<id>x<lon>y<lat>,...>` (osmium add-locations-to-ways). */
  static Way parseWay(String line) {
    long id = 0;
    int version = 0;
    Map<String, String> tags = new LinkedHashMap<>();
    List<long[]> refs = new ArrayList<>();
    List<double[]> locations = new ArrayList<>();
    for (String field : line.split(" ")) {
      if (field.isEmpty()) continue;
      char key = field.charAt(0);
      String value = field.substring(1);
      switch (key) {
        case 'w' -> id = Long.parseLong(value);
        case 'v' -> version = Integer.parseInt(value);
        case 'T' -> {
          if (!value.isEmpty())
            for (String pair : value.split(",")) {
              int separator = pair.indexOf('=');
              tags.put(decodeOpl(pair.substring(0, separator)), decodeOpl(pair.substring(separator + 1)));
            }
        }
        case 'N' -> {
          if (!value.isEmpty())
            for (String node : value.split(",")) {
              int x = node.indexOf('x');
              int y = node.indexOf('y');
              if (x < 0 || y < 0) throw new IllegalStateException("WAY_NODE_WITHOUT_LOCATION: w" + id);
              refs.add(new long[] {Long.parseLong(node.substring(1, x))});
              locations.add(
                  new double[] {
                    Double.parseDouble(node.substring(x + 1, y)), Double.parseDouble(node.substring(y + 1))
                  });
            }
        }
        default -> {}
      }
    }
    long[] nodes = new long[refs.size()];
    double[] xs = new double[refs.size()];
    double[] ys = new double[refs.size()];
    for (int i = 0; i < nodes.length; i++) {
      nodes[i] = refs.get(i)[0];
      xs[i] = locations.get(i)[0];
      ys[i] = locations.get(i)[1];
    }
    return new Way(id, version, tags, nodes, xs, ys);
  }
}
