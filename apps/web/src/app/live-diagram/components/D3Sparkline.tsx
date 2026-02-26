"use client";

import { useRef, useEffect, useId } from "react";
import { scaleLinear } from "d3-scale";
import { area, line, curveMonotoneX } from "d3-shape";
import { select } from "d3-selection";
import "d3-transition";
import styles from "../styles.module.css";

interface D3SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  className?: string;
}

export function D3Sparkline({
  values,
  width = 80,
  height = 24,
  color = "#3b82f6",
  className,
}: D3SparklineProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gradientId = useId();

  useEffect(() => {
    if (!svgRef.current || values.length < 2) return;

    const svg = select(svgRef.current);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const padding = (max - min) * 0.1 || 1;

    const x = scaleLinear()
      .domain([0, values.length - 1])
      .range([0, width]);

    const y = scaleLinear()
      .domain([min - padding, max + padding])
      .range([height, 0]);

    // --- gradient definition ---
    const defs = svg.selectAll<SVGDefsElement, unknown>("defs").data([null]);
    const defsEnter = defs.enter().append("defs");
    const grad = defsEnter
      .append("linearGradient")
      .attr("id", gradientId)
      .attr("x1", "0")
      .attr("y1", "0")
      .attr("x2", "0")
      .attr("y2", "1");
    grad.append("stop").attr("offset", "0%").attr("stop-color", color).attr("stop-opacity", 0.3);
    grad.append("stop").attr("offset", "100%").attr("stop-color", color).attr("stop-opacity", 0);
    // update existing gradient stops on color change
    defs.select("linearGradient").selectAll("stop").data([0.3, 0]).attr("stop-color", color);

    // --- area path ---
    const areaGen = area<number>()
      .x((_, i) => x(i))
      .y0(height)
      .y1((d) => y(d))
      .curve(curveMonotoneX);

    const areaPath = svg.selectAll<SVGPathElement, number[]>("path.sparkArea").data([values]);
    areaPath
      .enter()
      .append("path")
      .attr("class", "sparkArea")
      .attr("fill", `url(#${gradientId})`)
      .attr("d", areaGen)
      .merge(areaPath)
      .transition()
      .duration(400)
      .attr("d", areaGen);

    // --- line path ---
    const lineGen = line<number>()
      .x((_, i) => x(i))
      .y((d) => y(d))
      .curve(curveMonotoneX);

    const linePath = svg.selectAll<SVGPathElement, number[]>("path.sparkLine").data([values]);
    linePath
      .enter()
      .append("path")
      .attr("class", "sparkLine")
      .attr("fill", "none")
      .attr("stroke", color)
      .attr("stroke-width", 1.5)
      .attr("d", lineGen)
      .merge(linePath)
      .transition()
      .duration(400)
      .attr("stroke", color)
      .attr("d", lineGen);
  }, [values, width, height, color, gradientId]);

  if (values.length < 2) return null;

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
    />
  );
}
